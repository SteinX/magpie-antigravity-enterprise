import { createHash, randomUUID } from "node:crypto"
import { createNativeSession } from "./auth.mjs"
import { PROVIDER, BASE, validateTarget, enterpriseURL, buildPayload, catalogModels, adaptResponse } from "./protocol.mjs"
import { nativeFetch } from "./transport.mjs"
import { quotaUsage } from "./usage.mjs"

const CATALOG = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels"
const QUOTA = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"
const LABEL = "Antigravity Enterprise"

function failed(message, status = 400, signIn) {
  const headers = { "content-type": "application/json" }
  if (signIn) headers["X-Magpie-Sign-In"] = signIn
  return new Response(JSON.stringify({ error: { message, type: status === 401 ? "authentication_error" : "invalid_request_error" } }), { status, headers })
}

function authError(message) {
  return Object.assign(new Error(message), { signIn: "expired" })
}

function requestSignal(signal) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
}

async function withSignal(task, signal) {
  signal.throwIfAborted()
  let abort
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
  })
  try {
    return await Promise.race([task(), cancelled])
  } finally {
    signal.removeEventListener("abort", abort)
  }
}

function boundedMap(map, key, value) {
  map.set(key, value)
  if (map.size > 256) map.delete(map.keys().next().value)
  return value
}

async function readJSON(response, operation) {
  if (!response.ok) {
    await response.body?.cancel()
    throw Object.assign(new Error(`${operation}: HTTP ${response.status}`), { signIn: response.status === 401 ? "expired" : "kept" })
  }
  const result = await response.json().catch(() => null)
  if (!result || typeof result !== "object") throw new Error(`${operation}: invalid JSON response`)
  return result
}

async function readResource(send, renew, signal, operation) {
  signal.throwIfAborted()
  let response = await send()
  signal.throwIfAborted()
  if (response.status === 401) {
    await response.body?.cancel()
    signal.throwIfAborted()
    await renew()
    signal.throwIfAborted()
    response = await send()
  }
  const result = await readJSON(response, operation)
  signal.throwIfAborted()
  return result
}

async function readRequestBody(request) {
  const { signal, body } = request
  signal.throwIfAborted()
  if (!body) return JSON.parse("")
  const reader = body.getReader()
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}) }
  signal.addEventListener("abort", abort, { once: true })
  try {
    const decoder = new TextDecoder()
    let text = ""
    while (true) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) return JSON.parse(text + decoder.decode())
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    signal.removeEventListener("abort", abort)
    reader.releaseLock()
  }
}

export const AntigravityEnterprisePlugin = async (_input = {}, options = {}) => {
  const fetch = options._deps?.fetch ?? nativeFetch
  const createSession = options._deps?.createNativeSession ?? createNativeSession
  let native = createSession(options)
  const trajectories = new Map()
  const trajectoryCounters = new Map()

  async function headersFor(profile, signal, session = native) {
    signal?.throwIfAborted()
    return {
      Authorization: `Bearer ${profile.token.access_token}`,
      "Content-Type": "application/json",
      "User-Agent": await session.identity(profile),
    }
  }

  async function licenses(profile, session, config, signal) {
    const binding = session.binding(profile)
    const result = await readResource(async () => {
      const headers = await headersFor(profile, signal, session)
      signal.throwIfAborted()
      return fetch(`${BASE}:fetchLicenses`, { headers, signal })
    }, async () => {
      profile = await session.profile({ signal, config, forceRefresh: true, interactive: true })
      if (session.binding(profile) !== binding) throw authError("The account signed in to Antigravity changed. Sign in to this provider again to bind the intended account")
    }, signal, "Fetching enterprise licenses")
    if (!Array.isArray(result.licenses)) throw new Error("The enterprise API returned no license list")
    return result.licenses
  }

  async function signedIn(auth, signal, forceRefresh = false, session = native) {
    if (auth?.type !== "api" || !auth.metadata?.nativeBinding) throw authError("Sign in with the local Antigravity enterprise account first")
    const metadata = auth.metadata
    const target = validateTarget(metadata)
    const profile = await session.profile({ signal, forceRefresh, config: metadata, interactive: false })
    if (session.binding(profile) !== metadata.nativeBinding) {
      throw authError("The account signed in to Antigravity changed. Sign in to this provider again to bind the intended account")
    }
    if (typeof metadata.userTier !== "string" || !metadata.userTier) throw authError("The saved account has no enterprise license. Sign in again and select its project and location")
    return { profile, metadata, target }
  }

  function trajectory(body, metadata, incomingHeaders) {
    const scope = [metadata.nativeBinding, metadata.projectId, metadata.location]
    let id = new Headers(incomingHeaders).get("x-aicode-trajectory-id")
    if (!id || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
      const firstUser = body.contents?.find((content) => content.role === "user")
      const key = createHash("sha256").update(JSON.stringify([...scope, body.systemInstruction ?? body.system_instruction, firstUser])).digest("hex")
      id = trajectories.get(key) ?? boundedMap(trajectories, key, randomUUID())
    }
    const key = JSON.stringify([...scope, id])
    const counter = trajectoryCounters.get(key) ?? boundedMap(trajectoryCounters, key, { id, next: 0 })
    const priorGenerations = body.contents?.reduce((count, content) => count + (content.role === "model" && content.parts?.some((part) => !Object.hasOwn(part, "functionResponse")) ? 1 : 0), 0) ?? 0
    counter.next = Math.max(counter.next, priorGenerations)
    return counter
  }

  const prompts = [
    { type: "text", key: "projectId", message: "Google Cloud project ID for your enterprise license", placeholder: "Your license's project ID", validate: (value) => /^[a-z0-9][a-z0-9.:-]*$/.test(value?.trim() ?? "") ? undefined : "Enter a project ID or project number" },
    { type: "text", key: "location", message: "Enterprise license location", placeholder: "global, us, or eu", validate: (value) => /^[a-z0-9-]+$/.test(value?.trim() ?? "") ? undefined : "Enter the location assigned to your license" },
    { type: "select", key: "authMethod", message: "Authentication used by the local Antigravity account", options: [
      { label: "Detect from the local sign-in", value: "auto" },
      { label: "Google Cloud SSO", value: "gcp" },
      { label: "Workforce Identity Federation", value: "wif" },
    ] },
    { type: "text", key: "wifProvider", message: "WIF provider from your administrator", placeholder: "locations/global/workforcePools/POOL/providers/PROVIDER", when: { key: "authMethod", op: "eq", value: "wif" } },
  ]

  const method = {
    type: "api", keyless: true, label: "Use the local Antigravity enterprise sign-in", prompts,
    async ask(inputs = {}) {
      const prompt = prompts.find((item) => !(item.key in inputs) && (!item.when || inputs[item.when.key] === item.when.value))
      if (!prompt) return null
      if (prompt.key === "projectId" || prompt.key === "location" || prompt.key === "wifProvider") {
        const profile = await createSession(options).profile({ interactive: true })
        const suggestion = prompt.key === "projectId" ? profile.project_id : prompt.key === "location" ? profile.region : profile.wif_provider
        return { ...prompt, placeholder: suggestion || prompt.placeholder }
      }
      return prompt
    },
    async authorize(inputs = {}, { signal } = {}) {
      const boundedSignal = requestSignal(signal)
      try {
        return await withSignal(async () => {
          const target = validateTarget(inputs)
          if (!["auto", "gcp", "wif"].includes(inputs.authMethod ?? "auto")) throw new Error("Choose a supported authentication method")
          if (inputs.authMethod === "wif" && !inputs.wifProvider?.trim()) throw new Error("Enter your WIF provider")
          const config = { ...target, authMethod: inputs.authMethod ?? "auto", wifProvider: inputs.wifProvider?.trim() ?? "" }
          const signingNative = createSession(options)
          const profile = await signingNative.profile({ signal: boundedSignal, config, interactive: true })
          boundedSignal.throwIfAborted()
          const available = await licenses(profile, signingNative, config, boundedSignal)
          const license = available.find((item) => item.projectId === target.projectId && item.location === target.location)
          if (!license?.userTier) throw new Error("This account has no enterprise license for that project and location. Check the values or select the intended account in Antigravity")
          const binding = signingNative.binding(profile)
          const metadata = { ...config, nativeBinding: binding, userTier: license.userTier, tierDisplayName: license.tierDisplayName || license.userTier }
          native = signingNative
          return { type: "success", key: `native-keychain:${binding}`, accountId: `${target.projectId}/${target.location}/${binding.slice(0, 12)}`, metadata }
        }, boundedSignal)
      } catch (error) {
        boundedSignal.throwIfAborted()
        return { type: "failed", error: error.message }
      }
    },
  }

  return {
    config: async (config) => {
      config.provider ??= {}
      config.provider[PROVIDER] ??= { name: LABEL, npm: "@ai-sdk/google", api: BASE, models: {} }
    },
    auth: {
      provider: PROVIDER,
      methods: [method],
      async usage(getAuth, _provider, { signal } = {}) {
        const boundedSignal = requestSignal(signal)
        try {
          return await withSignal(async () => {
            const auth = await getAuth()
            boundedSignal.throwIfAborted()
            const session = native
            let state = await signedIn(auth, boundedSignal, false, session)
            const summary = await readResource(async () => {
              const headers = await headersFor(state.profile, boundedSignal, session)
              boundedSignal.throwIfAborted()
              return fetch(QUOTA, {
                method: "POST", headers, signal: boundedSignal,
                body: JSON.stringify({ project: state.target.projectId }),
              })
            }, async () => { state = await signedIn(auth, boundedSignal, true, session) }, boundedSignal, "Fetching enterprise quota")
            boundedSignal.throwIfAborted()
            return quotaUsage(summary, { metadata: state.metadata })
          }, boundedSignal)
        } catch (error) {
          boundedSignal.throwIfAborted()
          if (error?.name === "AbortError") throw error
          return { error: error.message, signIn: error.signIn === "expired" ? "expired" : "kept" }
        }
      },
      async loader(getAuth) {
        if (!(await getAuth())?.metadata?.nativeBinding) return {}
        return {
          baseURL: BASE,
          async fetch(input, init = {}) {
            let signal
            try {
              const request = new Request(input, init)
              signal = request.signal
              signal.throwIfAborted()
              const match = /\/models\/([^/:?]+):(streamGenerateContent|generateContent)(?:\?|$)/.exec(request.url)
              if (!match) return failed("This provider supports Gemini generateContent and streamGenerateContent requests", 404)
              const model = decodeURIComponent(match[1])
              if (request.method !== "POST") return failed("This provider requires POST for Gemini generation requests", 405)
              const body = await readRequestBody(request)
              const auth = await getAuth()
              let state = await signedIn(auth, signal)
              const payload = buildPayload(body, model, state.metadata.userTier)
              const currentTrajectory = trajectory(body, state.metadata, request.headers)
              const send = async () => {
                const headers = await headersFor(state.profile, signal)
                headers["Accept-Encoding"] = "gzip"
                headers["X-Aicode-Trajectory-Id"] = currentTrajectory.id
                headers["X-Aicode-Request-Id"] = `${currentTrajectory.id}-${currentTrajectory.next++}`
                return fetch(enterpriseURL(state.target), { method: "POST", headers, body: JSON.stringify(payload), signal })
              }
              let response = await send()
              // A rejected token has not generated a reply; renew once, never replay a successful turn.
              if (response.status === 401) {
                await response.body?.cancel()
                state = await signedIn(auth, signal, true)
                response = await send()
              }
              return await adaptResponse(response, match[2] === "streamGenerateContent", { signal })
            } catch (error) {
              if (signal?.aborted || error.name === "AbortError") throw error
              return failed(error.message, error.signIn === "expired" ? 401 : error instanceof SyntaxError ? 400 : 502, error.signIn)
            }
          },
        }
      },
    },
    provider: {
      id: PROVIDER,
      async models(_provider, { auth, signal } = {}) {
        if (!auth?.metadata?.nativeBinding) return {}
        const boundedSignal = requestSignal(signal)
        return withSignal(async () => {
          const session = native
          let state = await signedIn(auth, boundedSignal, false, session)
          const result = await readResource(async () => {
            const headers = await headersFor(state.profile, boundedSignal, session)
            boundedSignal.throwIfAborted()
            return fetch(CATALOG, {
              method: "POST", headers, signal: boundedSignal,
              body: JSON.stringify({ project: state.target.projectId, location: state.target.location, entitlement: { userTier: state.metadata.userTier } }),
            })
          }, async () => { state = await signedIn(auth, boundedSignal, true, session) }, boundedSignal, "Fetching the enterprise model catalog")
          return catalogModels(result)
        }, boundedSignal)
      },
    },
  }
}
