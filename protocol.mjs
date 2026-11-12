export const PROVIDER = "antigravity-enterprise"
export const BASE = "https://businessaicode.googleapis.com/v1beta"

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const LOCATIONS = new Set(["global", "us", "eu"])
const ACTIONS = new Set(["generateContent", "streamGenerateContent", "countTokens"])
const REQUEST_FIELDS = ["contents", "systemInstruction", "tools", "toolConfig", "generationConfig", "labels"]

export function validateTarget(target) {
  if (!isObject(target) || typeof target.projectId !== "string" || !target.projectId.trim()) {
    throw new Error("Set this account's projectId to its Google Cloud project ID or project number.")
  }
  const projectId = target.projectId.trim()
  if (!/^[a-z0-9][a-z0-9.:-]*$/.test(projectId)) {
    throw new Error("projectId must be a Google Cloud project ID or project number, without a projects/ prefix, URL, or whitespace.")
  }
  if (typeof target.location !== "string" || !target.location.trim()) {
    throw new Error("Set this account's location explicitly to global, us, or eu.")
  }
  const location = target.location.trim().toLowerCase()
  if (!LOCATIONS.has(location)) {
    throw new Error(`Unsupported Antigravity Enterprise location ${JSON.stringify(target.location)}; use global, us, or eu. In-country regions such as us-central1 are not supported.`)
  }
  return { projectId, location }
}

export function enterpriseURL(target, action = "streamGenerateContent", stream = true) {
  const { projectId, location } = validateTarget(target)
  if (!ACTIONS.has(action)) throw new Error(`Unsupported Gemini action ${JSON.stringify(action)}.`)
  const host = location === "global" ? "businessaicode.googleapis.com" : `businessaicode.${location}.rep.googleapis.com`
  return `https://${host}/v1beta/projects/${encodeURIComponent(projectId)}/locations/${location}:${action}${stream ? "?alt=sse" : ""}`
}

// Native Google Schema is an OpenAPI subset, not arbitrary JSON Schema:
// https://googleapis.github.io/js-genai/release_docs/interfaces/types.Schema.html
const NATIVE_SCHEMA_FIELDS = new Set([
  "type", "format", "title", "description", "nullable", "default", "items",
  "minItems", "maxItems", "enum", "properties", "propertyOrdering", "required",
  "minProperties", "maxProperties", "minimum", "maximum", "minLength",
  "maxLength", "pattern", "example", "anyOf",
])

function needsJsonSchema(schema) {
  if (!isObject(schema)) return typeof schema === "boolean"
  for (const [key, value] of Object.entries(schema)) {
    if (!NATIVE_SCHEMA_FIELDS.has(key)) return true
    if (key === "type" && Array.isArray(value)) return true
    if (key === "enum" && Array.isArray(value) && value.some((entry) => typeof entry !== "string")) return true
    if (key === "items" && (Array.isArray(value) || needsJsonSchema(value))) return true
    if (key === "properties" && isObject(value) && Object.values(value).some(needsJsonSchema)) return true
    if (key === "anyOf" && Array.isArray(value) && value.some(needsJsonSchema)) return true
  }
  return false
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return tools
  return tools.map((tool) => {
    if (!isObject(tool) || !Array.isArray(tool.functionDeclarations)) return tool
    return {
      ...tool,
      functionDeclarations: tool.functionDeclarations.map((declaration) => {
        if (!isObject(declaration)) return declaration
        if (Object.hasOwn(declaration, "parametersJsonSchema")) {
          const { parameters, ...rest } = declaration
          return rest
        }
        if (Object.hasOwn(declaration, "parameters") && needsJsonSchema(declaration.parameters)) {
          const { parameters, ...rest } = declaration
          return { ...rest, parametersJsonSchema: parameters }
        }
        return declaration
      }),
    }
  })
}

export function buildPayload(body, model, userTier) {
  if (!isObject(body)) throw new TypeError("The Gemini request body must be a JSON object.")
  if (typeof model !== "string" || !model.trim()) throw new Error("Select an enabled model ID from this account's Antigravity model catalog.")
  if (typeof userTier !== "string" || !userTier.trim()) throw new Error("Set this account's userTier to its enterprise license tier.")

  // businessaicode takes a flat, allowlisted request. The selected account and
  // exact catalog ID take precedence over any caller-supplied routing fields.
  const payload = {}
  for (const key of REQUEST_FIELDS) {
    if (Object.hasOwn(body, key)) payload[key] = body[key]
  }
  if (!Object.hasOwn(body, "systemInstruction") && Object.hasOwn(body, "system_instruction")) {
    payload.systemInstruction = body.system_instruction
  }
  if (Object.hasOwn(payload, "tools")) payload.tools = normalizeTools(payload.tools)
  payload.aicode = { experience: model }
  payload.entitlement = { userTier }
  return payload
}

function mimeTypes(model) {
  const supported = model.supportedMimeTypes
  return Array.isArray(supported) ? supported.filter((mime) => typeof mime === "string") : isObject(supported) ? Object.keys(supported).filter((mime) => supported[mime] !== false) : []
}

export function catalogModels(catalog) {
  if (!isObject(catalog?.models)) return {}
  const rank = new Map()
  for (const sort of catalog.agentModelSorts ?? []) {
    for (const group of sort?.groups ?? []) {
      for (const id of group?.modelIds ?? []) {
        if (!rank.has(id)) rank.set(id, rank.size)
      }
    }
  }
  const models = Object.entries(catalog.models).filter(([, info]) => isObject(info) && info.disabled !== true)
  // Picker metadata determines ordering only. Missing IDs remain available;
  // consumer-client hidden lists are not enterprise entitlement evidence.
  models.sort(([a], [b]) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity))
  return Object.fromEntries(models.map(([id, info]) => {
    const mimes = mimeTypes(info)
    const input = {
      text: true,
      image: info.supportsImages === true || mimes.some((mime) => mime.startsWith("image/")),
      audio: mimes.some((mime) => mime.startsWith("audio/")),
      video: info.supportsVideo === true || mimes.some((mime) => mime.startsWith("video/")),
      pdf: mimes.includes("application/pdf"),
    }
    return [id, {
      id,
      providerID: PROVIDER,
      name: typeof info.displayName === "string" && info.displayName ? info.displayName : id,
      api: { id, url: BASE, npm: "@ai-sdk/google" },
      status: "active",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: {
        context: Number.isFinite(info.maxTokens) ? info.maxTokens : 0,
        output: Number.isFinite(info.maxOutputTokens) ? info.maxOutputTokens : 0,
      },
      options: {},
      headers: {},
      capabilities: {
        temperature: true,
        reasoning: info.supportsThinking === true || info.supportsAdaptiveThinking === true,
        attachment: input.image || input.audio || input.video || input.pdf,
        toolcall: true,
        input,
        output: { text: true, image: false, audio: false, video: false, pdf: false },
        interleaved: false,
      },
      release_date: "",
      variants: {},
    }]
  }))
}

function appendParts(parts, incoming) {
  for (const part of incoming) {
    const previous = parts.at(-1)
    // Signed parts and tool calls must retain their exact part boundaries and
    // ordering. Only plain text deltas can safely be combined.
    const plainText = (value) => isObject(value) && typeof value.text === "string" && Object.keys(value).every((key) => key === "text" || key === "thought")
    if (plainText(part) && plainText(previous) && previous.thought === part.thought) previous.text += part.text
    else parts.push(isObject(part) ? { ...part } : part)
  }
}

function responseAccumulator() {
  const output = { candidates: [] }
  const candidates = new Map()
  return {
    add(chunk) {
      if (!isObject(chunk)) throw new TypeError("The enterprise SSE event must contain a Gemini response object.")
      for (const [key, value] of Object.entries(chunk)) {
        if (key === "candidates") continue
        if (key === "usageMetadata" && isObject(value)) output.usageMetadata = { ...output.usageMetadata, ...value }
        else output[key] = value
      }
      for (const [position, candidate] of (chunk.candidates ?? []).entries()) {
        if (!isObject(candidate)) throw new TypeError("The enterprise SSE response contains an invalid candidate.")
        const index = Number.isInteger(candidate.index) ? candidate.index : position
        const accumulated = candidates.get(index) ?? {}
        const { content, ...metadata } = candidate
        Object.assign(accumulated, metadata)
        if (isObject(content)) {
          const parts = accumulated.content?.parts ?? []
          appendParts(parts, content.parts ?? [])
          accumulated.content = { ...accumulated.content, ...content, parts }
        }
        candidates.set(index, accumulated)
      }
    },
    value() {
      output.candidates = [...candidates.entries()].sort(([a], [b]) => a - b).map(([, candidate]) => candidate)
      return output
    },
  }
}

const ERROR_HTTP_STATUS = new Map([
  ["CANCELLED", 499], ["UNKNOWN", 500], ["INVALID_ARGUMENT", 400],
  ["DEADLINE_EXCEEDED", 504], ["NOT_FOUND", 404], ["ALREADY_EXISTS", 409],
  ["PERMISSION_DENIED", 403], ["UNAUTHENTICATED", 401], ["RESOURCE_EXHAUSTED", 429],
  ["FAILED_PRECONDITION", 400], ["ABORTED", 409], ["OUT_OF_RANGE", 400],
  ["UNIMPLEMENTED", 501], ["INTERNAL", 500], ["UNAVAILABLE", 503], ["DATA_LOSS", 500],
])

function streamError(error) {
  if (!isObject(error) || typeof error.message !== "string" ||
      (Object.hasOwn(error, "code") && (!Number.isInteger(error.code) || error.code < 400 || error.code > 599)) ||
      (Object.hasOwn(error, "status") && typeof error.status !== "string")) {
    throw new TypeError("The enterprise SSE error event must contain a Google error object.")
  }
  return { status: error.code ?? ERROR_HTTP_STATUS.get(error.status) ?? 502, body: { error } }
}

function sseParser(onEvent) {
  let buffer = ""
  let data = []
  let eventType = ""
  let done = false
  const dispatch = () => {
    const type = eventType
    eventType = ""
    if (!data.length) {
      if (type === "error") throw new TypeError("The enterprise SSE error event is missing its payload.")
      return
    }
    const payload = data.join("\n")
    data = []
    if (type !== "error" && payload.trim() === "[DONE]") done = true
    else done = onEvent(JSON.parse(payload), type) === true
  }
  const line = (value) => {
    if (value === "") return dispatch()
    const colon = value.indexOf(":")
    const field = colon < 0 ? value : value.slice(0, colon)
    if (field !== "data" && field !== "event") return
    let valuePart = colon < 0 ? "" : value.slice(colon + 1)
    if (valuePart.startsWith(" ")) valuePart = valuePart.slice(1)
    if (field === "event") eventType = valuePart
    else data.push(valuePart)
  }
  return {
    push(text, final = false) {
      buffer += text
      while (!done) {
        const separator = /[\r\n]/.exec(buffer)
        if (!separator) break
        const index = separator.index
        if (!final && buffer[index] === "\r" && index === buffer.length - 1) break
        const width = buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1
        const value = buffer.slice(0, index)
        buffer = buffer.slice(index + width)
        line(value)
      }
      if (final && !done) {
        if (buffer) line(buffer)
        buffer = ""
        dispatch()
      }
      return done
    },
  }
}

function quotaResetSeconds(error) {
  if (Array.isArray(error.details)) {
    for (const detail of error.details) {
      if (!isObject(detail) || detail["@type"] !== "type.googleapis.com/google.rpc.RetryInfo" || typeof detail.retryDelay !== "string") continue
      const duration = /^((?:0|[1-9]\d*))(?:\.\d{1,9})?s$/.exec(detail.retryDelay)
      if (!duration || Number(duration[1]) > 315576000000) continue
      const seconds = Number(detail.retryDelay.slice(0, -1))
      if (Number.isFinite(seconds) && seconds > 0) return seconds
    }
  }
  const duration = /\bResets in\s+(\S+)/i.exec(error.message)?.[1].replace(/\.$/, "")
  const parts = duration && /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(duration)
  if (!parts || !parts.slice(1).some((part) => part !== undefined)) return undefined
  const seconds = Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

function localResetTime(date) {
  const pad = (value) => String(value).padStart(2, "0")
  const offset = -date.getTimezoneOffset()
  const zone = `GMT${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${zone}`
}

function quotaErrorBody(body, status, headers, now) {
  if (status !== 429 || !isObject(body) || !isObject(body.error) ||
      typeof body.error.message !== "string" || !/Quota pool exhausted/i.test(body.error.message)) return body
  const error = body.error
  const seconds = quotaResetSeconds(error)
  let reset
  if (seconds !== undefined) {
    const dateHeader = headers.get("date")
    const serverTime = Date.parse(dateHeader ?? "")
    const reference = Number.isFinite(serverTime) && new Date(serverTime).toUTCString() === dateHeader ? serverTime : now()
    const candidate = new Date(Number.isFinite(reference) ? reference + seconds * 1000 : NaN)
    if (Number.isFinite(candidate.getTime())) reset = candidate
  }
  const waiting = seconds === undefined ? undefined : Math.ceil(seconds)
  const estimate = reset ? `预计 ${localResetTime(reset)} 重置（约${Math.floor(waiting / 3600)}小时${Math.floor(waiting % 3600 / 60)}分${waiting % 60}秒）。` : ""
  return { ...body, error: {
    ...error,
    type: "quota_exhausted",
    message: `当前模型的企业额度池已耗尽（Quota pool exhausted）。${estimate}请等待重置，或联系企业管理员开启超额用量；重新登录不会恢复额度。`,
    ...(reset ? { reset_at: reset.toISOString() } : {}),
  } }
}

function jsonHeaders(original) {
  const headers = new Headers(original)
  headers.set("content-type", "application/json")
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.delete("transfer-encoding")
  return headers
}

async function clonedErrorJSON(response, signal) {
  if (signal?.aborted) {
    await response.body?.cancel(signal.reason).catch(() => {})
    signal.throwIfAborted()
  }
  let reader
  try { reader = response.clone().body?.getReader() } catch { return undefined }
  if (!reader) return undefined
  const decoder = new TextDecoder()
  let text = ""
  let cancellation
  // A clone tees the body: cancel both branches together so an abort can reach
  // the upstream source without waiting for the untouched original branch.
  const cancel = (reason) => cancellation ??= Promise.all([
    reader.cancel(reason).catch(() => {}),
    response.body.cancel(reason).catch(() => {}),
  ])
  const onAbort = () => { void cancel(signal.reason) }
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    signal?.throwIfAborted()
    while (true) {
      const { value, done } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } catch {
    if (signal?.aborted) {
      await cancel(signal.reason)
      signal.throwIfAborted()
    }
    return undefined
  } finally {
    signal?.removeEventListener("abort", onAbort)
    reader.releaseLock()
  }
}

export async function adaptResponse(response, wantsStream, { signal, now = Date.now } = {}) {
  if (response.status === 429) {
    const body = await clonedErrorJSON(response, signal)
    signal?.throwIfAborted()
    const adapted = quotaErrorBody(body, response.status, response.headers, now)
    if (adapted === body) return response
    await response.body?.cancel().catch(() => {})
    signal?.throwIfAborted()
    return new Response(JSON.stringify(adapted), {
      status: response.status,
      statusText: response.statusText,
      headers: jsonHeaders(response.headers),
    })
  }
  if (!response.ok || wantsStream || !response.body || !/^\s*text\/event-stream(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) return response

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const accumulator = responseAccumulator()
  let failure
  const parser = sseParser((chunk, type) => {
    if (type === "error" || (isObject(chunk) && Object.hasOwn(chunk, "error"))) {
      failure = streamError(isObject(chunk) && Object.hasOwn(chunk, "error") ? chunk.error : chunk)
      return true
    }
    accumulator.add(chunk)
    return false
  })
  let cancellation
  const cancel = (reason) => cancellation ??= reader.cancel(reason).catch(() => {})
  const onAbort = () => { void cancel(signal.reason) }
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    signal?.throwIfAborted()
    while (true) {
      const { value, done } = await reader.read()
      signal?.throwIfAborted()
      const terminal = parser.push(done ? decoder.decode() : decoder.decode(value, { stream: true }), done)
      if (terminal) await cancel()
      if (done || terminal) break
    }
    signal?.throwIfAborted()
    const body = failure ? quotaErrorBody(failure.body, failure.status, response.headers, now) : accumulator.value()
    return new Response(JSON.stringify(body), {
      status: failure ? failure.status : response.status,
      statusText: failure ? undefined : response.statusText,
      headers: jsonHeaders(response.headers),
    })
  } catch (error) {
    await cancel(error)
    throw error
  } finally {
    signal?.removeEventListener("abort", onAbort)
    reader.releaseLock()
  }
}
