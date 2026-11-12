import { createHash, randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { createNativeSession } from "./auth.mjs"
import { KeychainError, readCredential, installCredential } from "./keychain.mjs"
import { EnterpriseLoginError, startEnterpriseLogin } from "./login.mjs"
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
  const startLogin = options._deps?.startEnterpriseLogin ?? startEnterpriseLogin
  const readLoginCredential = options._deps?.readLoginCredential ?? readCredential
  const installLoginCredential = options._deps?.installLoginCredential ?? installCredential
  const stateDir = options.stateDir ?? join(homedir(), ".config/magpie/antigravity-enterprise")
  const nativeSessions = new Map()
  const trajectories = new Map()
  const trajectoryCounters = new Map()

  function sessionFor(auth) {
    if (auth?.type !== "api" || typeof auth.metadata?.nativeBinding !== "string" || !auth.metadata.nativeBinding) throw authError("Sign in with the local Antigravity enterprise account first")
    const binding = auth.metadata.nativeBinding
    return nativeSessions.get(binding) ?? boundedMap(nativeSessions, binding, createSession(options))
  }

  async function headersFor(profile, signal, session) {
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

  async function signedIn(auth, signal, forceRefresh = false, session = sessionFor(auth)) {
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
    { type: "select", key: "authMethod", message: "Enterprise authentication method", options: [
      { label: "Google Cloud SSO", value: "gcp" },
      { label: "Workforce Identity Federation", value: "wif" },
    ] },
    { type: "text", key: "wifProvider", message: "WIF provider from your administrator", placeholder: "locations/global/workforcePools/POOL/providers/PROVIDER", when: { key: "authMethod", op: "eq", value: "wif" } },
  ]
  const reusePrompts = prompts.map((prompt) => prompt.key === "authMethod" ? {
    ...prompt, message: "Authentication used by the local Antigravity account",
    options: [{ label: "Detect from the local sign-in", value: "auto" }, ...prompt.options],
  } : prompt)
  const nextPrompt = (items, inputs) => items.find((item) => !(item.key in inputs) && (!item.when || inputs[item.when.key] === item.when.value)) ?? null
  const loginError = (message) => Object.assign(new Error(message), { name: "EnterpriseSignInError" })
  const loginFailure = (error) => ({ type: "failed", error: error instanceof EnterpriseLoginError || error instanceof KeychainError || ["EnterpriseSignInError", "NativeAuthError", "CliMetadataError"].includes(error?.name)
    ? error.message : "Enterprise sign-in failed. Try signing in again; no credential details were recorded." })

  function signInConfig(inputs, reuse = false) {
    const target = validateTarget(inputs)
    const authMethod = inputs.authMethod ?? (reuse ? "auto" : undefined)
    if (!(reuse ? ["auto", "gcp", "wif"] : ["gcp", "wif"]).includes(authMethod)) throw new Error("Choose a supported authentication method")
    const wifProvider = typeof inputs.wifProvider === "string" ? inputs.wifProvider.trim() : ""
    if (authMethod === "wif" && !wifProvider) throw new Error("Enter your WIF provider")
    return { ...target, authMethod, wifProvider: authMethod === "gcp" ? "" : wifProvider }
  }

  function selectedLicense(available, config) {
    if (!Array.isArray(available)) throw loginError("The enterprise API returned no license list")
    const license = available.find((item) => item?.projectId === config.projectId && item?.location === config.location && typeof item.userTier === "string" && item.userTier.trim())
    if (!license) throw loginError("This account has no enterprise license for that project and location. Check the values and sign in with the intended enterprise account")
    return license
  }

  function signInResult(profile, session, config, license) {
    const binding = session.binding(profile)
    const metadata = { ...config, nativeBinding: binding, userTier: license.userTier, tierDisplayName: typeof license.tierDisplayName === "string" && license.tierDisplayName ? license.tierDisplayName : license.userTier }
    return { type: "success", key: `native-keychain:${binding}`, accountId: `${config.projectId}/${config.location}/${binding.slice(0, 12)}`, metadata }
  }

  const browserMethod = {
    type: "oauth", label: "Sign in with enterprise account", prompts,
    async ask(inputs = {}) { return nextPrompt(prompts, inputs) },
    async authorize(inputs = {}, { signal } = {}) {
      let config
      try { config = signInConfig(inputs) } catch (error) { return { type: "failed", error: error.message } }
      let flow
      let closed = false
      const close = () => {
        signal?.removeEventListener("abort", cancel)
        if (!closed && flow) { closed = true; return flow.close() }
      }
      const cancel = () => { void Promise.resolve().then(close).catch(() => {}) }
      try {
        const snapshotSignal = requestSignal(signal)
        const snapshot = await withSignal(async () => {
          try { return await readLoginCredential(stateDir, { signal: snapshotSignal, interactive: true }) }
          catch (error) { if (error?.code === "ERR_NATIVE_KEYCHAIN_MISSING") return null; throw error }
        }, snapshotSignal)
        signal?.throwIfAborted()
        flow = await startLogin(config, options, { signal })
        signal?.throwIfAborted()
        signal?.addEventListener("abort", cancel, { once: true })
        return {
          url: flow.url, method: "auto", instructions: "Complete enterprise sign-in in your browser, then return to Magpie.", opened: false,
          async callback(_inputs, { signal: callbackSignal } = {}) {
            const loginSignal = signal && callbackSignal ? AbortSignal.any([signal, callbackSignal]) : signal ?? callbackSignal
            try {
              loginSignal?.throwIfAborted()
              if (closed) throw loginError("This enterprise sign-in has closed. Start sign-in again.")
              const token = await (loginSignal ? withSignal(() => flow.wait({ signal: loginSignal }), loginSignal) : flow.wait())
              loginSignal?.throwIfAborted()
              if (!token || typeof token.access_token !== "string" || !token.access_token || typeof token.refresh_token !== "string" || !token.refresh_token || typeof token.token_type !== "string" || !token.token_type || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
                throw loginError("The enterprise sign-in returned an invalid token. Sign in again.")
              }
              const expiry = new Date(Date.now() + token.expires_in * 1000)
              if (!Number.isFinite(expiry.getTime())) throw loginError("The enterprise sign-in returned an invalid token expiry. Sign in again.")
              const profile = {
                token: { access_token: token.access_token, refresh_token: token.refresh_token, token_type: token.token_type, expiry: expiry.toISOString() },
                auth_method: config.authMethod, wif_provider: config.wifProvider, project_id: config.projectId, region: config.location, user_tier: "",
              }
              const signingNative = createSession(options)
              const licenseSignal = requestSignal(loginSignal)
              const license = await withSignal(async () => {
                const headers = await headersFor(profile, licenseSignal, signingNative)
                licenseSignal.throwIfAborted()
                const response = await fetch(`${BASE}:fetchLicenses`, { headers, signal: licenseSignal })
                licenseSignal.throwIfAborted()
                if (!response.ok) {
                  await response.body?.cancel()
                  throw loginError(`Fetching enterprise licenses: HTTP ${response.status}`)
                }
                const result = await readJSON(response, "Fetching enterprise licenses")
                licenseSignal.throwIfAborted()
                return selectedLicense(result.licenses, config)
              }, licenseSignal)
              profile.user_tier = license.userTier
              if (typeof license.tierDisplayName === "string" && license.tierDisplayName) profile.tier_display_name = license.tierDisplayName
              const replacement = "go-keyring-base64:" + Buffer.from(JSON.stringify(profile)).toString("base64")
              loginSignal?.throwIfAborted()
              const installSignal = requestSignal(loginSignal)
              const installed = await withSignal(() => installLoginCredential(stateDir, snapshot, replacement, { signal: installSignal, interactive: true }), installSignal)
              if (!installed) throw loginError("Antigravity changed its native account during sign-in. The newer credentials were preserved; sign in again.")
              const profileSignal = requestSignal(loginSignal)
              const verified = await withSignal(() => signingNative.profile({ signal: profileSignal, config, interactive: true, expectedCredential: replacement }), profileSignal)
              profileSignal.throwIfAborted()
              const result = signInResult(verified, signingNative, config, license)
              boundedMap(nativeSessions, result.metadata.nativeBinding, signingNative)
              return result
            } catch (error) {
              loginSignal?.throwIfAborted()
              if (error?.name === "AbortError") throw error
              return loginFailure(error)
            } finally { await close() }
          },
        }
      } catch (error) {
        await close()
        signal?.throwIfAborted()
        if (error?.name === "AbortError") throw error
        return loginFailure(error)
      }
    },
  }

  const reuseMethod = {
    type: "api", keyless: true, label: "Use existing local Antigravity sign-in", prompts: reusePrompts,
    async ask(inputs = {}) {
      const prompt = nextPrompt(reusePrompts, inputs)
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
          const config = signInConfig(inputs, true)
          const signingNative = createSession(options)
          const profile = await signingNative.profile({ signal: boundedSignal, config, interactive: true })
          boundedSignal.throwIfAborted()
          const available = await licenses(profile, signingNative, config, boundedSignal)
          const license = selectedLicense(available, config)
          const result = signInResult(profile, signingNative, config, license)
          boundedMap(nativeSessions, result.metadata.nativeBinding, signingNative)
          return result
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
      methods: [browserMethod, reuseMethod],
      async usage(getAuth, _provider, { signal } = {}) {
        const boundedSignal = requestSignal(signal)
        try {
          return await withSignal(async () => {
            const auth = await getAuth()
            boundedSignal.throwIfAborted()
            const session = sessionFor(auth)
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
              const session = sessionFor(auth)
              let state = await signedIn(auth, signal, false, session)
              const payload = buildPayload(body, model, state.metadata.userTier)
              const currentTrajectory = trajectory(body, state.metadata, request.headers)
              const send = async () => {
                const headers = await headersFor(state.profile, signal, session)
                headers["Accept-Encoding"] = "gzip"
                headers["X-Aicode-Trajectory-Id"] = currentTrajectory.id
                headers["X-Aicode-Request-Id"] = `${currentTrajectory.id}-${currentTrajectory.next++}`
                return fetch(enterpriseURL(state.target), { method: "POST", headers, body: JSON.stringify(payload), signal })
              }
              let response = await send()
              // A rejected token has not generated a reply; renew once, never replay a successful turn.
              if (response.status === 401) {
                await response.body?.cancel()
                state = await signedIn(auth, signal, true, session)
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
          const session = sessionFor(auth)
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
