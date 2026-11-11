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

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return tools
  return tools.map((tool) => {
    if (!isObject(tool) || !Array.isArray(tool.functionDeclarations)) return tool
    return {
      ...tool,
      functionDeclarations: tool.functionDeclarations.map((declaration) => {
        if (!isObject(declaration) || !Object.hasOwn(declaration, "parametersJsonSchema")) return declaration
        const { parametersJsonSchema, ...rest } = declaration
        return { ...rest, parameters: parametersJsonSchema }
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
      video: mimes.some((mime) => mime.startsWith("video/")),
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
        reasoning: info.supportsThinking === true,
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

function sseParser(onEvent) {
  let buffer = ""
  let data = []
  let done = false
  const dispatch = () => {
    if (!data.length) return
    const payload = data.join("\n")
    data = []
    if (payload.trim() === "[DONE]") done = true
    else onEvent(JSON.parse(payload))
  }
  const line = (value) => {
    if (value === "") return dispatch()
    const colon = value.indexOf(":")
    const field = colon < 0 ? value : value.slice(0, colon)
    if (field !== "data") return
    let valuePart = colon < 0 ? "" : value.slice(colon + 1)
    if (valuePart.startsWith(" ")) valuePart = valuePart.slice(1)
    data.push(valuePart)
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

export function adaptResponse(response, wantsStream) {
  if (!response.ok || wantsStream || !response.body || !/^\s*text\/event-stream(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) return response

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const accumulator = responseAccumulator()
  const parser = sseParser((chunk) => accumulator.add(chunk))
  let canceled = false
  const body = new ReadableStream({
    async pull(controller) {
      try {
        while (!canceled) {
          const { value, done } = await reader.read()
          if (canceled) return
          const terminal = parser.push(done ? decoder.decode() : decoder.decode(value, { stream: true }), done)
          if (terminal) await reader.cancel()
          if (canceled) return
          if (done || terminal) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(accumulator.value())))
            controller.close()
            return
          }
        }
      } catch (error) {
        if (!canceled) {
          controller.error(error)
          try { await reader.cancel(error) } catch {}
        }
      } finally {
        reader.releaseLock()
      }
    },
    async cancel(reason) {
      canceled = true
      try { await reader.cancel(reason) } finally { reader.releaseLock() }
    },
  })
  const headers = new Headers(response.headers)
  headers.set("content-type", "application/json")
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.delete("transfer-encoding")
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}
