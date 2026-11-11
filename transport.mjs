import { connect, constants } from "node:http2"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { connect as connectTcp, isIP } from "node:net"
import { connect as connectTls } from "node:tls"
import { createGunzip } from "node:zlib"

const hopByHop = new Set(["connection", "host", "http2-settings", "keep-alive", "proxy-authorization", "proxy-connection", "transfer-encoding", "upgrade"])
const redirects = new Set([301, 302, 303, 307, 308])
const emptyStatuses = new Set([204, 205, 304])
const hostname = (url) => url.hostname.replace(/^\[|\]$/g, "")
const port = (url) => url.port || (url.protocol === "https:" ? "443" : "80")
const abortReason = (signal) => signal.reason ?? new DOMException("The operation was aborted", "AbortError")
const failure = (cause) => new TypeError("HTTP/2 request failed", { cause })

function bypassProxy(url) {
  const host = hostname(url).toLowerCase().replace(/\.$/, "")
  const rules = process.env.no_proxy || process.env.NO_PROXY || ""
  return rules.split(/[\s,]+/).some((entry) => {
    if (!entry) return false
    if (entry === "*") return true
    let rule = entry.toLowerCase()
    let rulePort
    if (rule.startsWith("[")) {
      const end = rule.indexOf("]")
      if (end < 0) return false
      rulePort = rule.slice(end + 1).replace(/^:/, "")
      rule = rule.slice(1, end)
    } else if (rule.indexOf(":") === rule.lastIndexOf(":")) {
      const colon = rule.lastIndexOf(":")
      if (colon !== -1) {
        rulePort = rule.slice(colon + 1)
        rule = rule.slice(0, colon)
      }
    }
    if (rulePort && rulePort !== port(url)) return false
    rule = rule.replace(/^\*?\./, "").replace(/\.$/, "")
    return host === rule || (!isIP(host) && host.endsWith(`.${rule}`))
  })
}

function proxyFor(url) {
  if (bypassProxy(url)) return null
  const value = (url.protocol === "https:" && (process.env.https_proxy || process.env.HTTPS_PROXY)) || process.env.http_proxy || process.env.HTTP_PROXY
  if (!value) return null
  let proxy
  try {
    proxy = new URL(value.includes("://") ? value : `http://${value}`)
  } catch {
    throw new TypeError("Invalid HTTP/2 proxy configuration")
  }
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") throw new TypeError("Unsupported HTTP/2 proxy protocol")
  return proxy
}

function tunnel(url, proxy, signal) {
  return new Promise((resolve, reject) => {
    let settled = false
    let request
    const done = (error, socket) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", abort)
      if (error) {
        request?.destroy()
        socket?.destroy()
        reject(error)
      } else resolve(socket)
    }
    const abort = () => done(abortReason(signal))
    if (signal?.aborted) return abort()
    const authority = `${url.hostname}:${port(url)}`
    const headers = { host: authority }
    try {
      if (proxy.username || proxy.password) {
        headers["proxy-authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`
      }
      request = (proxy.protocol === "https:" ? httpsRequest : httpRequest)({
        hostname: hostname(proxy),
        port: port(proxy),
        method: "CONNECT",
        path: authority,
        headers,
        agent: false,
        rejectUnauthorized: true,
      })
      request.on("error", (error) => done(failure(error)))
      request.once("connect", (response, socket, head) => {
        if (settled) return socket.destroy()
        if (response.statusCode !== 200) return done(new TypeError("HTTP/2 proxy CONNECT failed"), socket)
        if (head.length) socket.unshift(head)
        done(null, socket)
      })
      request.once("response", (response) => {
        response.resume()
        done(new TypeError("HTTP/2 proxy CONNECT failed"))
      })
      request.once("close", () => {
        if (!settled) done(new TypeError("HTTP/2 proxy closed before CONNECT completed"))
      })
      signal?.addEventListener("abort", abort, { once: true })
      request.end()
    } catch (error) {
      done(failure(error))
    }
  })
}

function connectSocket(url, socket, signal) {
  return new Promise((resolve, reject) => {
    let connected
    let settled = false
    const done = (error) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", abort)
      if (error) {
        connected?.destroy()
        socket?.destroy()
        reject(error)
      } else resolve(connected)
    }
    const abort = () => done(abortReason(signal))
    if (signal?.aborted) return abort()
    try {
      if (url.protocol === "https:") {
        connected = connectTls({
          host: hostname(url),
          port: Number(port(url)),
          ...(socket ? { socket } : {}),
          ...(isIP(hostname(url)) ? {} : { servername: hostname(url) }),
          ALPNProtocols: ["h2"],
          // Leaving ca unset preserves Node/Bun's default roots and NODE_EXTRA_CA_CERTS.
          rejectUnauthorized: true,
        })
        connected.once("secureConnect", () => {
          if (connected.alpnProtocol !== "h2") return done(new TypeError("HTTP/2 is required; the server did not negotiate h2"))
          done()
        })
      } else if (socket) {
        connected = socket
        done()
      } else {
        connected = connectTcp({ host: hostname(url), port: Number(port(url)) })
        connected.once("connect", () => done())
      }
      connected.on("error", (error) => done(failure(error)))
      connected.once("close", () => {
        if (!settled) done(new TypeError("HTTP/2 connection closed before it was established"))
      })
      if (!settled) signal?.addEventListener("abort", abort, { once: true })
    } catch (error) {
      done(failure(error))
    }
  })
}

function requestBody(body, headers) {
  if (body == null) return null
  if (typeof body === "string") return Buffer.from(body)
  if (body instanceof URLSearchParams) {
    if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8")
    return Buffer.from(body.toString())
  }
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  throw new TypeError("HTTP/2 request body must be a string, URLSearchParams, or bytes")
}

/** A request-owned HTTP/2 transport for the controlled Google API calls. */
export async function nativeFetch(input, init = {}) {
  const url = new URL(input)
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError("Unsupported HTTP/2 URL protocol")
  if (url.username || url.password) throw new TypeError("HTTP/2 URLs must not contain credentials")
  const host = hostname(url)
  if (url.protocol === "http:" && host !== "localhost" && host !== "::1" && !/^127\./.test(host)) {
    throw new TypeError("Cleartext HTTP/2 is restricted to loopback endpoints")
  }
  const signal = init.signal
  if (signal?.aborted) throw abortReason(signal)
  const method = (init.method || "GET").toUpperCase()
  const headers = new Headers(init.headers)
  const body = requestBody(init.body, headers)
  if ((method === "GET" || method === "HEAD") && body !== null) throw new TypeError("GET and HEAD requests must not have a body")
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "gzip")
  if (url.pathname.endsWith(":streamGenerateContent")) headers.delete("content-length")
  else if (method === "POST") {
    headers.delete("content-length")
    if (body?.byteLength) headers.set("content-length", String(body.byteLength))
  }
  const outgoing = {
    ":method": method,
    ":path": `${url.pathname}${url.search}`,
    ":authority": url.host,
    ":scheme": url.protocol.slice(0, -1),
  }
  for (const [name, value] of headers) if (!hopByHop.has(name)) outgoing[name] = value
  const proxy = proxyFor(url)
  let socket = proxy ? await tunnel(url, proxy, signal) : undefined
  socket = await connectSocket(url, socket, signal)
  if (signal?.aborted) {
    socket.destroy()
    throw abortReason(signal)
  }

  return new Promise((resolve, reject) => {
    let session
    let request
    let source
    let controller
    let responded = false
    let bodyEnded = false
    let requestClosed = false
    let finished = false
    const finish = (error, canceled = false) => {
      if (finished) return
      finished = true
      signal?.removeEventListener("abort", abort)
      if (error) {
        controller?.error(error)
        reject(error)
      } else if (!canceled) controller?.close()
      if (source && source !== request) source.destroy()
      // There is exactly one request on this connection; nothing is kept alive.
      if (request && !request.destroyed) request.close(canceled || error ? constants.NGHTTP2_CANCEL : constants.NGHTTP2_NO_ERROR)
      session?.destroy()
      socket.destroy()
    }
    const endBody = () => {
      bodyEnded = true
      // A reset can emit readable EOF before its error/close events.
      if (requestClosed) finish()
    }
    const abort = () => finish(abortReason(signal))
    signal?.addEventListener("abort", abort, { once: true })
    try {
      session = connect(url.origin, { createConnection: () => socket, settings: { enablePush: false } })
      session.on("error", (error) => finish(failure(error)))
      session.once("close", () => {
        if (!responded) finish(new TypeError("HTTP/2 connection closed before response headers"))
      })
      request = session.request(outgoing, { endStream: body === null })
      request.on("error", (error) => finish(failure(error)))
      request.once("aborted", () => finish(new TypeError("HTTP/2 response was aborted")))
      request.once("close", () => {
        requestClosed = true
        if (!responded || request.rstCode !== constants.NGHTTP2_NO_ERROR) {
          finish(new TypeError("HTTP/2 stream closed before the response completed"))
        } else if (bodyEnded) finish()
      })
      request.once("response", (incoming) => {
        responded = true
        if (init.redirect === "error" && redirects.has(incoming[":status"])) {
          finish(new TypeError("HTTP/2 redirect is not allowed"))
          return
        }
        try {
          const responseHeaders = new Headers()
          for (const [name, value] of Object.entries(incoming)) {
            if (name.startsWith(":")) continue
            if (Array.isArray(value)) for (const entry of value) responseHeaders.append(name, entry)
            else if (value !== undefined) responseHeaders.set(name, String(value))
          }
          const noBody = method === "HEAD" || emptyStatuses.has(incoming[":status"])
          if (noBody) {
            request.once("end", endBody)
            request.resume()
            resolve(new Response(null, { status: incoming[":status"], headers: responseHeaders }))
            return
          }
          source = request
          if (responseHeaders.get("content-encoding")?.trim().toLowerCase() === "gzip") {
            source = createGunzip()
            responseHeaders.delete("content-encoding")
            responseHeaders.delete("content-length")
          }
          source.pause()
          const responseBody = new ReadableStream({
            start(value) {
              controller = value
              source.on("data", (chunk) => {
                if (finished) return
                controller.enqueue(chunk)
                if (controller.desiredSize <= 0) source.pause()
              })
              source.once("end", endBody)
              source.on("error", (error) => finish(failure(error)))
            },
            pull() { source.resume() },
            cancel() { finish(null, true) },
          }, { highWaterMark: 0 })
          if (source !== request) request.pipe(source)
          resolve(new Response(responseBody, { status: incoming[":status"], headers: responseHeaders }))
        } catch (error) {
          finish(failure(error))
        }
      })
      if (body !== null) request.end(body)
    } catch (error) {
      finish(failure(error))
    }
  })
}
