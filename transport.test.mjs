import test from "node:test"
import assert from "node:assert/strict"
import { createServer, createSecureServer, constants as h2Constants } from "node:http2"
import { createServer as createHttpServer } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import { connect as connectTcp } from "node:net"
import { once } from "node:events"
import { createGzip, gzipSync, constants as zlibConstants } from "node:zlib"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { nativeFetch } from "./transport.mjs"

const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const proxyKeys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"]

function environment(t, values = {}) {
  const previous = Object.fromEntries(proxyKeys.map((name) => [name, process.env[name]]))
  for (const name of proxyKeys) delete process.env[name]
  Object.assign(process.env, { NO_PROXY: "*", ...values })
  t.after(() => {
    for (const name of proxyKeys) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
  })
}

async function listen(t, server, host = "127.0.0.1") {
  const sockets = new Set()
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("error", () => {})
    socket.once("close", () => sockets.delete(socket))
  })
  server.on("tlsClientError", () => {})
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, host, resolve)
  })
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve))
    for (const socket of sockets) socket.destroy()
    await closed
  })
  return server.address().port
}

async function h2Fixture(t, handler, secure = false, host = "127.0.0.1") {
  const server = secure ? createSecureServer({ key, cert, allowHTTP1: false }) : createServer()
  const sessions = new Set()
  const closed = deferred()
  server.on("session", (session) => {
    sessions.add(session)
    session.on("error", () => {})
    session.once("close", () => { sessions.delete(session); closed.resolve() })
  })
  server.on("stream", (stream, headers) => {
    stream.on("error", () => {})
    handler(stream, headers)
  })
  const port = await listen(t, server, host)
  t.after(() => { for (const session of sessions) session.destroy() })
  const authority = host.includes(":") ? `[${host}]` : host
  return { url: `${secure ? "https" : "http"}://${authority}:${port}`, port, closed: closed.promise, sessions }
}

function incomingBody(stream) {
  const chunks = []
  stream.on("data", (chunk) => chunks.push(chunk))
  return new Promise((resolve) => stream.once("end", () => resolve(Buffer.concat(chunks))))
}

test("HTTP/2 sends the native pseudo headers without fetch's implicit Accept or HTTP/1 headers", { timeout: 5000 }, async (t) => {
  environment(t)
  const observed = deferred()
  const fixture = await h2Fixture(t, async (stream, headers) => {
    const body = await incomingBody(stream)
    observed.resolve({ headers, body })
    const response = gzipSync('{"error":"licensed seat required"}')
    stream.respond({ ":status": 403, "content-type": "application/json", "content-encoding": "gzip", "content-length": String(response.length), "x-request-id": "native-error" })
    stream.end(response)
  })
  const payload = '{"query":"東京"}'
  const response = await nativeFetch(`${fixture.url}/v1beta/catalog?alt=json`, {
    method: "post",
    headers: { "user-agent": "antigravity/cli/test", "content-type": "application/json", host: "untrusted.invalid", connection: "keep-alive", "proxy-authorization": "must-not-leak" },
    body: payload,
  })
  assert.equal(response.status, 403)
  assert.equal(response.headers.get("x-request-id"), "native-error")
  assert.equal(response.headers.get("content-encoding"), null)
  assert.equal(response.headers.get("content-length"), null)
  assert.deepEqual(await response.json(), { error: "licensed seat required" })
  const { headers, body } = await observed.promise
  assert.equal(headers[":method"], "POST")
  assert.equal(headers[":path"], "/v1beta/catalog?alt=json")
  assert.equal(headers[":authority"], new URL(fixture.url).host)
  assert.equal(headers[":scheme"], "http")
  assert.equal(headers["content-length"], String(Buffer.byteLength(payload)))
  assert.equal(headers["accept-encoding"], "gzip")
  assert.equal(headers["user-agent"], "antigravity/cli/test")
  for (const name of ["accept", "connection", "host", "proxy-authorization", "transfer-encoding"]) assert.equal(headers[name], undefined)
  assert.equal(body.toString(), payload)
  await fixture.closed
  assert.equal(fixture.sessions.size, 0)
})

test("generation omits Content-Length while known POST payloads use their byte lengths", { timeout: 5000 }, async (t) => {
  environment(t)
  const requests = []
  const fixture = await h2Fixture(t, async (stream, headers) => {
    requests.push({ headers, body: await incomingBody(stream) })
    stream.respond({ ":status": 200 })
    stream.end("ok")
  })
  const backing = new Uint8Array([0, 1, 2, 3, 4])
  const cases = [
    { path: "/v1beta/projects/test:streamGenerateContent?alt=sse", body: "{}", headers: { "content-length": "900" }, expected: "{}", length: undefined },
    { path: "/v1/token", body: new URLSearchParams({ scope: "a b", token: "東京" }), expected: "scope=a+b&token=%E6%9D%B1%E4%BA%AC" },
    { path: "/bytes", body: backing.subarray(1, 4), expected: Buffer.from([1, 2, 3]) },
    { path: "/array-buffer", body: new Uint8Array([5, 6]).buffer, expected: Buffer.from([5, 6]) },
    { path: "/empty", body: "", expected: "", length: undefined },
  ]
  for (const entry of cases) {
    assert.equal(await (await nativeFetch(fixture.url + entry.path, { method: "POST", body: entry.body, headers: entry.headers })).text(), "ok")
    const actual = requests.at(-1)
    assert.deepEqual(actual.body, Buffer.from(entry.expected))
    assert.equal(actual.headers["content-length"], Object.hasOwn(entry, "length") ? entry.length : String(Buffer.byteLength(entry.expected)))
  }
  assert.equal(requests[1].headers["content-type"], "application/x-www-form-urlencoded;charset=UTF-8")
  assert.equal(requests.length, cases.length)
})

test("explicit Accept-Encoding and Accept headers reach the server unchanged", { timeout: 5000 }, async (t) => {
  environment(t)
  let observed
  const fixture = await h2Fixture(t, (stream, headers) => {
    observed = headers
    stream.respond({ ":status": 200, "content-length": "5", "x-original": "preserved" })
    stream.end("plain")
  })
  const response = await nativeFetch(fixture.url, { headers: { "accept-encoding": "identity", accept: "application/json" } })
  assert.equal(await response.text(), "plain")
  assert.equal(response.headers.get("content-length"), "5")
  assert.equal(response.headers.get("x-original"), "preserved")
  assert.equal(observed["accept-encoding"], "identity")
  assert.equal(observed.accept, "application/json")
})

test("gzip is decoded incrementally before the server finishes the response", { timeout: 5000 }, async (t) => {
  environment(t)
  const finish = deferred()
  const fixture = await h2Fixture(t, (stream) => {
    stream.respond({ ":status": 200, "content-type": "text/event-stream", "content-encoding": "gzip" })
    const gzip = createGzip()
    gzip.on("error", () => {})
    gzip.pipe(stream)
    gzip.write("data: first\n\n")
    gzip.flush(zlibConstants.Z_SYNC_FLUSH)
    finish.promise.then(() => gzip.end("data: last\n\n"))
    stream.once("close", () => gzip.destroy())
  })
  const response = await nativeFetch(fixture.url)
  const reader = response.body.getReader()
  try {
    const first = await reader.read()
    assert.equal(Buffer.from(first.value).toString(), "data: first\n\n")
    assert.equal(first.done, false)
    finish.resolve()
    const chunks = []
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      chunks.push(result.value)
    }
    assert.equal(Buffer.concat(chunks).toString(), "data: last\n\n")
    await fixture.closed
  } finally {
    finish.resolve()
    await reader.cancel().catch(() => {})
  }
})

test("a slow consumer applies backpressure and cancellation closes its connection", { timeout: 5000 }, async (t) => {
  environment(t)
  const limit = 1024
  let writes = 0
  const fixture = await h2Fixture(t, (stream) => {
    stream.respond({ ":status": 200 })
    const block = Buffer.alloc(64 * 1024, 65)
    const pump = () => {
      while (!stream.destroyed && writes < limit) {
        writes++
        if (!stream.write(block)) return
      }
      if (!stream.destroyed) stream.end()
    }
    stream.on("drain", pump)
    pump()
  })
  const response = await nativeFetch(fixture.url)
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.ok(first.value.byteLength > 0)
  assert.ok(writes < limit, "The transport must not buffer the complete 64 MiB response before delivering a chunk")
  await reader.cancel()
  await fixture.closed
  assert.equal(fixture.sessions.size, 0)
  assert.ok(writes < limit)
})

test("canceling an unread 401 body closes its request-owned HTTP/2 session", { timeout: 5000 }, async (t) => {
  environment(t)
  const fixture = await h2Fixture(t, (stream) => {
    stream.respond({ ":status": 401, "content-type": "application/json" })
    stream.write('{"error":"expired"}')
  })
  const response = await nativeFetch(fixture.url)
  assert.equal(response.status, 401)
  await response.body.cancel()
  await fixture.closed
  assert.equal(fixture.sessions.size, 0)
})

test("abort before headers rejects with the signal reason and destroys the session", { timeout: 5000 }, async (t) => {
  environment(t)
  const started = deferred()
  const fixture = await h2Fixture(t, () => started.resolve())
  const controller = new AbortController()
  const reason = new Error("canceled before headers")
  const pending = nativeFetch(fixture.url, { signal: controller.signal })
  const rejected = assert.rejects(pending, (error) => error === reason)
  await started.promise
  controller.abort(reason)
  await rejected
  await fixture.closed
  await assert.rejects(nativeFetch(fixture.url, { signal: controller.signal }), (error) => error === reason)
  assert.equal(fixture.sessions.size, 0)
})

test("abort after headers errors the response body and closes the session", { timeout: 5000 }, async (t) => {
  environment(t)
  const fixture = await h2Fixture(t, (stream) => {
    stream.respond({ ":status": 200 })
    stream.write("first")
  })
  const controller = new AbortController()
  const response = await nativeFetch(fixture.url, { signal: controller.signal })
  const reader = response.body.getReader()
  assert.equal(Buffer.from((await reader.read()).value).toString(), "first")
  const reason = new Error("canceled after headers")
  controller.abort(reason)
  await assert.rejects(reader.read(), (error) => error === reason)
  await fixture.closed
})

test("HTTP/2 failures reject before headers and error readable bodies after headers", { timeout: 5000 }, async (t) => {
  environment(t)
  const reset = deferred()
  const fixture = await h2Fixture(t, (stream, headers) => {
    if (headers[":path"] === "/before") return stream.close(h2Constants.NGHTTP2_INTERNAL_ERROR)
    stream.respond({ ":status": 200 })
    stream.write("first")
    // Keep the response unfinished when injecting the server failure.
    reset.promise.then(() => stream.destroy(new Error("synthetic upstream failure")))
  })
  await assert.rejects(nativeFetch(`${fixture.url}/before`))
  const response = await nativeFetch(`${fixture.url}/after`)
  const reader = response.body.getReader()
  assert.equal(Buffer.from((await reader.read()).value).toString(), "first")
  reset.resolve()
  await assert.rejects(reader.read())
})

test("truncated gzip errors the body and releases the HTTP/2 connection", { timeout: 5000 }, async (t) => {
  environment(t)
  const fixture = await h2Fixture(t, (stream) => {
    stream.respond({ ":status": 200, "content-encoding": "gzip" })
    stream.end(gzipSync("truncated payload").subarray(0, -5))
  })
  const response = await nativeFetch(fixture.url)
  await assert.rejects(response.text())
  await fixture.closed
})

test("redirects are returned without following and redirect:error hides the Location", { timeout: 5000 }, async (t) => {
  environment(t)
  let requests = 0
  const location = "https://example.invalid/private?token=synthetic-secret"
  const fixture = await h2Fixture(t, (stream) => {
    requests++
    stream.respond({ ":status": 302, location })
    stream.end("redirect body")
  })
  const response = await nativeFetch(fixture.url)
  assert.equal(response.status, 302)
  assert.equal(response.headers.get("location"), location)
  assert.equal(await response.text(), "redirect body")
  await assert.rejects(nativeFetch(fixture.url, { redirect: "error" }), (error) => {
    assert.ok(!error.message.includes("private"))
    assert.ok(!error.message.includes("synthetic-secret"))
    return true
  })
  assert.equal(requests, 2)
})

test("HEAD and null-body status responses preserve headers and close the session", { timeout: 5000 }, async (t) => {
  environment(t)
  const fixture = await h2Fixture(t, (stream, headers) => {
    stream.respond({ ":status": Number(headers[":path"].slice(1)) || 200, "x-result": "empty" })
    stream.end()
  })
  for (const status of [204, 205, 304]) {
    const response = await nativeFetch(`${fixture.url}/${status}`)
    assert.equal(response.status, status)
    assert.equal(response.body, null)
    assert.equal(response.headers.get("x-result"), "empty")
  }
  const head = await nativeFetch(fixture.url, { method: "HEAD" })
  assert.equal(head.body, null)
  assert.equal(head.status, 200)
})

test("HTTP/1-only endpoints reject without falling back", { timeout: 5000 }, async (t) => {
  environment(t)
  let requests = 0
  const server = createHttpServer((request, response) => { requests++; response.end("not h2") })
  const port = await listen(t, server)
  await assert.rejects(nativeFetch(`http://127.0.0.1:${port}`))
  assert.equal(requests, 0)
})

async function proxyFixture(t, secure = false, rejectConnect = false) {
  const connected = deferred()
  const closed = deferred()
  const requests = []
  const peers = new Set()
  const server = secure ? createHttpsServer({ key, cert }) : createHttpServer()
  server.on("connect", (request, client, head) => {
    requests.push({ path: request.url, headers: request.headers })
    client.once("close", () => closed.resolve())
    connected.resolve()
    if (rejectConnect) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n")
      return
    }
    const targetPort = Number(request.url.slice(request.url.lastIndexOf(":") + 1))
    const upstream = connectTcp({ host: "127.0.0.1", port: targetPort })
    peers.add(upstream)
    upstream.on("error", () => client.destroy())
    upstream.once("close", () => { peers.delete(upstream); client.destroy() })
    client.once("close", () => upstream.destroy())
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
  })
  const port = await listen(t, server)
  t.after(() => { for (const socket of peers) socket.destroy() })
  return { url: `${secure ? "https" : "http"}://127.0.0.1:${port}`, requests, connected: connected.promise, closed: closed.promise }
}

async function trustedChild(t, url, env = {}, action = "text", headers = {}) {
  const directory = await mkdtemp(join(tmpdir(), "agy-h2-ca-"))
  const caPath = join(directory, "ca.pem")
  await writeFile(caPath, cert)
  t.after(() => rm(directory, { recursive: true, force: true }))
  const program = `
    import { nativeFetch } from ${JSON.stringify(new URL("./transport.mjs", import.meta.url).href)};
    try {
      const response = await nativeFetch(process.argv[1], {method: "POST", body: "fixture", headers: ${JSON.stringify(headers)}});
      const text = ${action === "cancel" ? "(await response.body.cancel(), 'canceled')" : "await response.text()"};
      console.log(JSON.stringify({status: response.status, text}));
    } catch (error) {
      console.log(JSON.stringify({error: error.message}));
      process.exitCode = 1;
    }
  `
  const child = spawn(process.execPath, ["--input-type=module", "-e", program, url], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: caPath, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  t.after(() => { if (child.exitCode === null) child.kill() })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
  const [code] = await once(child, "close")
  return { code, result: JSON.parse(stdout.trim()), stderr }
}

test("TLS certificate validation remains enabled", { timeout: 5000 }, async (t) => {
  environment(t)
  const fixture = await h2Fixture(t, (stream) => { stream.respond({ ":status": 200 }); stream.end("untrusted") }, true)
  await assert.rejects(nativeFetch(fixture.url))
  assert.equal(fixture.sessions.size, 0)
})

test("default TLS roots include NODE_EXTRA_CA_CERTS without a transport-specific option", { timeout: 10000 }, async (t) => {
  environment(t)
  const fixture = await h2Fixture(t, async (stream) => {
    assert.equal((await incomingBody(stream)).toString(), "fixture")
    stream.respond({ ":status": 200 })
    stream.end("trusted h2")
  }, true)
  const child = await trustedChild(t, fixture.url)
  assert.equal(child.code, 0, child.stderr)
  assert.deepEqual(child.result, { status: 200, text: "trusted h2" })
  await fixture.closed
})

test("trusted TLS endpoints must negotiate h2", { timeout: 10000 }, async (t) => {
  environment(t)
  const requests = []
  const server = createHttpsServer({ key, cert, ALPNProtocols: ["http/1.1"] }, (request, response) => {
    requests.push(request.headers)
    response.end("HTTP/1")
  })
  const port = await listen(t, server)
  const child = await trustedChild(t, `https://127.0.0.1:${port}`, {}, "text", { authorization: "Bearer synthetic-upstream-token" })
  assert.equal(child.code, 1)
  assert.deepEqual(requests, [], "No HTTP/1 request or authorization may reach the server")
})

test("HTTP and HTTPS CONNECT keep proxy Basic credentials out of the upstream request and close tunnels", { timeout: 20000 }, async (t) => {
  environment(t)
  for (const secure of [false, true]) {
    await t.test(secure ? "HTTPS proxy" : "HTTP proxy", async (t) => {
      const fixture = await h2Fixture(t, async (stream, headers) => {
        assert.equal(headers["proxy-authorization"], undefined)
        assert.equal(headers["content-length"], "7")
        assert.equal((await incomingBody(stream)).toString(), "fixture")
        stream.respond({ ":status": 200 })
        stream.end("proxied h2")
      }, true)
      const proxy = await proxyFixture(t, secure)
      const proxyUrl = new URL(proxy.url)
      proxyUrl.username = "fixture-user"
      proxyUrl.password = "fixture-password"
      const child = await trustedChild(t, fixture.url, { NO_PROXY: "", HTTPS_PROXY: proxyUrl.href })
      assert.equal(child.code, 0, child.stderr)
      assert.deepEqual(child.result, { status: 200, text: "proxied h2" })
      assert.equal(proxy.requests.length, 1)
      assert.equal(proxy.requests[0].path, `127.0.0.1:${fixture.port}`)
      assert.equal(proxy.requests[0].headers["proxy-authorization"], `Basic ${Buffer.from("fixture-user:fixture-password").toString("base64")}`)
      await Promise.all([fixture.closed, proxy.closed])
    })
  }
})

test("canceling a proxied response also closes the CONNECT socket", { timeout: 10000 }, async (t) => {
  environment(t)
  const fixture = await h2Fixture(t, async (stream) => {
    await incomingBody(stream)
    stream.respond({ ":status": 401 })
    stream.write("expired")
  }, true)
  const proxy = await proxyFixture(t)
  const child = await trustedChild(t, fixture.url, { NO_PROXY: "", HTTPS_PROXY: proxy.url }, "cancel")
  assert.equal(child.code, 0, child.stderr)
  assert.deepEqual(child.result, { status: 401, text: "canceled" })
  await Promise.all([fixture.closed, proxy.closed])
})

test("proxy handshake failures reject without disclosing proxy credentials", { timeout: 5000 }, async (t) => {
  const proxy = await proxyFixture(t, false, true)
  const proxyUrl = new URL(proxy.url)
  proxyUrl.username = "fixture-user"
  proxyUrl.password = "fixture-password"
  environment(t, { NO_PROXY: "", https_proxy: proxyUrl.href })
  await assert.rejects(nativeFetch("https://127.0.0.1:1"), (error) => {
    assert.ok(!error.message.includes("fixture-user"))
    assert.ok(!error.message.includes("fixture-password"))
    return true
  })
  await proxy.closed
})

test("aborting a pending CONNECT handshake closes the proxy socket", { timeout: 5000 }, async (t) => {
  const started = deferred()
  const disconnected = deferred()
  const closed = deferred()
  const server = createHttpServer()
  server.on("connect", (request, socket) => {
    socket.once("close", closed.resolve)
    socket.once("end", () => { disconnected.resolve(); socket.end() })
    // CONNECT hands ownership of a paused, half-open socket to this handler.
    socket.resume()
    started.resolve()
  })
  const port = await listen(t, server)
  environment(t, { NO_PROXY: "", HTTPS_PROXY: `http://127.0.0.1:${port}` })
  const controller = new AbortController()
  const reason = new Error("canceled CONNECT")
  const pending = nativeFetch("https://127.0.0.1:1", { signal: controller.signal })
  const rejected = assert.rejects(pending, (error) => error === reason)
  await started.promise
  controller.abort(reason)
  await rejected
  await disconnected.promise
  await closed.promise
})

test("NO_PROXY matches domains, case, wildcards, and effective ports", { timeout: 10000 }, async (t) => {
  environment(t)
  const fixture = await h2Fixture(t, (stream) => { stream.respond({ ":status": 200 }); stream.end("direct") })
  const proxy = await proxyFixture(t, false, true)
  process.env.HTTP_PROXY = proxy.url
  const local = `http://localhost:${fixture.port}`
  for (const rule of ["*", "localhost", ".localhost", "*.localhost", `LOCALHOST:${fixture.port}`, `irrelevant.invalid, localhost:${fixture.port}`, "127.0.0.1"]) {
    process.env.NO_PROXY = rule
    const target = rule === "127.0.0.1" ? fixture.url : local
    assert.equal(await (await nativeFetch(target)).text(), "direct")
  }
  for (const rule of ["other.localhost", `localhost:${fixture.port + 1}`]) {
    process.env.NO_PROXY = rule
    await assert.rejects(nativeFetch(local))
  }
  assert.equal(proxy.requests.length, 2)
  process.env.NO_PROXY = "other.localhost"
  process.env.no_proxy = "localhost"
  assert.equal(await (await nativeFetch(local)).text(), "direct")
})

// Synthetic localhost-only fixture. It is never trusted through a production option;
// child processes load it through the runtime's normal NODE_EXTRA_CA_CERTS support.
const key = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC4CpIE1cpX4f93
5mMIh7K51Z1LJwGwnC8M6+JiW9qKIcfa1cLAORl1wdhVaNbu5BC51mfNuOqKOfVb
OVpdy+2lkLvLOK4+oVkTzlLQIKI1RvqTiw4KKaMDTJLLhSdvtJbm5/uc7yI/T+4S
cJf1RuMf1OBuRkN4KL7xRgRB8BHskJWEW6dvER2JCkl7PpuSczy44lgp/iUuvhS3
6QQeJQ6BK1yyHzpSvjHR5lidBfNiCP0O8/VNMWy1SBXGa3K/MvBgTxYhHmK64lwG
2DGnQXPvc6v5D5DI8TqbXqXWNiuNkKuPhubieChgolWyXpgZQX9N+wZWdBkEvrp+
D6pOBZZZAgMBAAECggEABvzdFx09mzaef4vvfgHA/Hiq3zvyPtAUopX2ONZ/UWKq
TER01N2WJOLLoaU4ZpuhiEd8FiiLkdyqKeDfQykcsyjv/cL/gqtCTuk05b1yII8Q
W+JvZwgLrh1jLs0LIUenDx9cbf9PupMArryNrdIXijwymp1FBIlE2V5Xh7Vjc4A9
K7oPYEmTSYxUccK3c8RU9HIySBQ3w5WWd6kgimDofFVn0iO35cEufs+88Wb+XmFL
DQpFsym6QPzozVt97YffOLSzUjeXoYRmupuG+AgsTaUa06VgHd/fd+lSnPWD/+zZ
/67k2lcV0q+owBtMEwdMfcsO9B28Lzzvp+CsgC6WLQKBgQD+j20uO5CRUZACPE2/
Qo7RlSDmL+lMGxpOutmZFyWkDDuuJKoMxYdzGI6EE1SKJK8Nn2o0A0mGoIi8PmMl
/0Ujb6ZvZubDslwCD+BPajS1Q312M/ce9SCY68G1MwE106T4LoStaLDMl2/opgNe
L7XXVFoCUnKe34+bkS8fxUSgwwKBgQC5FQppdYWZKrnBj53ZR2Ab6RkyGCO/V76V
4jdH0xmYfOdMYhb4Ye1vMslDfyvlcjKoypaJ9odsRBb9qpHjxn/hqZOgbQgj+jie
CUEtjspjDv5J/ozlIVp0pY1iqxTDPEA1FwyGpV86IiN/a1gWP3sJ+eGMLTlg8UBh
nFtOiR86swKBgQDbVo/3tyEw5XtVQcqn0tymX32yeXPmvK+lSMB3dYdcW6IMwdC4
Inc8R9t8l/9O7J7c+RAUcwSmeKp4sLTTp6lWCDz7XknWM1et+yoGo3d4/Acdk1cK
GKKWwQTucV1ImO1bXxG5LSyxjIbDik/6ltdzC15nA815cR4XKDjXgi1I6wKBgFke
pY3UVglDxoBKrEJEmSW3Xzd84jGviYjYja/bGVcQxbtE/DSLyu2hccI7iSKJk5Ut
P8Gc4Oaj/sIUkP0xxsAdjIVSGvpf8UU/xY+vUwrR3GY62RM3tTu3v9XD9VJxP6WQ
vKpVFP6EE722LYtA8/kAxrddy2Q/prWZuWmeo1f7AoGBAPuzS7xP93JCWjPkLdZI
A4V9B9dkXZxXWRHUU3X8x8nPuyob4TMrdmtxTg55uqAFDtlmDti8o+BdisVuQykR
c66a+mYVfzGxFDyrefWwI0/QuyZunfcDp1PTy77jn52JjZYAmGVszkw+k8kksGAE
4nriQq8RBB7oOM+Sh3bmYObH
-----END PRIVATE KEY-----`
const cert = `-----BEGIN CERTIFICATE-----
MIIDGDCCAgCgAwIBAgIUUOgVMrQQ3zsYSnbz6xHm4fenuLowDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTExMTEzNTEwMVoYDzIxMjYx
MDE4MTM1MTAxWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQC4CpIE1cpX4f935mMIh7K51Z1LJwGwnC8M6+JiW9qK
Icfa1cLAORl1wdhVaNbu5BC51mfNuOqKOfVbOVpdy+2lkLvLOK4+oVkTzlLQIKI1
RvqTiw4KKaMDTJLLhSdvtJbm5/uc7yI/T+4ScJf1RuMf1OBuRkN4KL7xRgRB8BHs
kJWEW6dvER2JCkl7PpuSczy44lgp/iUuvhS36QQeJQ6BK1yyHzpSvjHR5lidBfNi
CP0O8/VNMWy1SBXGa3K/MvBgTxYhHmK64lwG2DGnQXPvc6v5D5DI8TqbXqXWNiuN
kKuPhubieChgolWyXpgZQX9N+wZWdBkEvrp+D6pOBZZZAgMBAAGjYDBeMB0GA1Ud
DgQWBBS5Tc3LqRQ1a1SC4f3VS4kGMc1EnDAPBgNVHRMBAf8EBTADAQH/MCwGA1Ud
EQQlMCOCCWxvY2FsaG9zdIcEfwAAAYcQAAAAAAAAAAAAAAAAAAAAATANBgkqhkiG
9w0BAQsFAAOCAQEAZUkBdMqyXxebCxDUbkGvUPswzQ3dfgkPEjfp4ddyDgB5BY8W
7NSsuNHa0vp6M8t8e0xQERid1vdFQVm9ZujbzoBvkcbG8RHwK5Fu+qsNdBv990EU
PY5LLvAk3ns3CBdIUYX+84jr1re5SFssJtOWcPWpk0jq+XFweMr/7nCEmnRcgZkI
3XTpsx5hQL3dAT7XtjH3N49mNZxuUx+AsamtUBgf/8NqTl/KUNEvsyTlapEaR8mz
poCPBk7BSceKeG2Rd2Y+2sKLilT5/j2dFMlVjA4IH0qgIa3ogxAOLqHi3SXtd3+W
Kf76zmBr6HT8z1Viw8zokoDzIMN3Hc34FUFjjg==
-----END CERTIFICATE-----`
