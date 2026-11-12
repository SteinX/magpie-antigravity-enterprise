import test from "node:test"
import assert from "node:assert/strict"
import { AntigravityEnterprisePlugin } from "./index.mjs"
import { createNativeSession } from "./auth.mjs"
import { KeychainError } from "./keychain.mjs"
import { EnterpriseLoginError } from "./login.mjs"

const endpoint = "https://businessaicode.googleapis.com/v1beta/models/gemini-3.8-flash-low:generateContent"
const encoder = new TextEncoder()
const inputBody = { contents: [{ role: "user", parts: [{ text: "Hello from the client" }] }] }
const answer = { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Enterprise answer" }] }, finishReason: "STOP" }], responseId: "enterprise-response" }
const wireAnswer = `data: ${JSON.stringify(answer)}\n\n`
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } })
const sse = () => new Response(wireAnswer, { headers: { "content-type": "text/event-stream", "x-request-id": "enterprise-request" } })
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(t, responses = [sse()], { binding = "native-account", onRequest } = {}) {
  const requests = []
  const profiles = []
  const metadata = { projectId: "licensed-project", location: "eu", nativeBinding: "native-account", userTier: "licensed-tier", authMethod: "auto", wifProvider: "" }
  const native = {
    async profile(options) {
      profiles.push(options)
      assert.notEqual(options.interactive, true, "Background work must not request Keychain UI")
      options.signal?.throwIfAborted()
      return { token: { access_token: options.forceRefresh ? "renewed-access" : "native-access" } }
    },
    binding: () => binding,
    identity: async () => "antigravity/native-test-client",
  }
  const fetch = async (url, init) => {
    requests.push({ url, ...init, headers: new Headers(init.headers), payload: JSON.parse(init.body) })
    onRequest?.(requests.at(-1))
    const response = responses[requests.length - 1]
    assert.ok(response, "An unexpected upstream request was made")
    if (response instanceof Error) throw response
    return response
  }
  const plugin = await AntigravityEnterprisePlugin({}, { _deps: { createNativeSession: () => native, fetch } })
  const client = await plugin.auth.loader(async () => ({ type: "api", metadata }))
  return { plugin, fetch: client.fetch, requests, profiles, metadata, native }
}

async function assertAnswer(response) {
  assert.ok(response instanceof Response)
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type"), /^application\/json/)
  assert.equal(response.headers.get("x-request-id"), "enterprise-request")
  assert.deepEqual(await response.json(), answer)
}

test("fetch(Request) reads its URL, JSON body, headers, and bound native account", async (t) => {
  const f = await fixture(t)
  const request = new Request(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-aicode-trajectory-id": "request-session", accept: "text/event-stream" },
    body: JSON.stringify(inputBody),
  })
  await assertAnswer(await f.fetch(request))
  assert.equal(request.bodyUsed, true)
  assert.equal(f.requests.length, 1)
  const sent = f.requests[0]
  assert.equal(sent.url, "https://businessaicode.eu.rep.googleapis.com/v1beta/projects/licensed-project/locations/eu:streamGenerateContent?alt=sse")
  assert.equal(sent.method, "POST")
  assert.deepEqual(sent.payload, { ...inputBody, aicode: { experience: "gemini-3.8-flash-low" }, entitlement: { userTier: "licensed-tier" } })
  assert.equal(sent.headers.get("x-aicode-trajectory-id"), "request-session")
  assert.equal(sent.headers.get("authorization"), "Bearer native-access")
  assert.equal(sent.headers.get("user-agent"), "antigravity/native-test-client")
  assert.equal(sent.headers.get("content-type"), "application/json")
  assert.equal(sent.headers.get("accept"), null)
  assert.equal(sent.headers.get("accept-encoding"), "gzip")
  assert.equal(sent.headers.get("x-aicode-request-id"), "request-session-0")
  assert.equal(f.profiles[0].config, f.metadata)
  assert.equal(f.profiles[0].signal, sent.signal)
})

test("fetch(URL, init) decodes a byte body and returns streaming responses intact", async (t) => {
  const upstream = sse()
  const f = await fixture(t, [upstream])
  const body = { contents: [{ role: "user", parts: [{ text: "東京" }] }] }
  const response = await f.fetch(new URL(endpoint.replace(":generateContent", ":streamGenerateContent?alt=sse")), {
    method: "post",
    headers: new Headers({ "x-aicode-trajectory-id": "url-session" }),
    body: encoder.encode(JSON.stringify(body)),
  })
  assert.equal(response, upstream)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), wireAnswer)
  assert.deepEqual(f.requests[0].payload.contents, body.contents)
  assert.equal(f.requests[0].headers.get("x-aicode-trajectory-id"), "url-session")
})

test("init body, headers, method, and signal override the Request values", async (t) => {
  const f = await fixture(t)
  const original = new AbortController()
  const override = new AbortController()
  const request = new Request(endpoint, {
    method: "PUT",
    headers: { "x-aicode-trajectory-id": "original-session" },
    body: JSON.stringify(inputBody),
    signal: original.signal,
  })
  original.abort(new Error("The original signal is overridden"))
  const body = { contents: [{ role: "user", parts: [{ text: "Replacement body" }] }] }
  await assertAnswer(await f.fetch(request, {
    method: "post",
    headers: [["x-aicode-trajectory-id", "override-session"]],
    body: new Blob([JSON.stringify(body)], { type: "application/json" }),
    signal: override.signal,
  }))
  assert.deepEqual(f.requests[0].payload.contents, body.contents)
  assert.equal(f.requests[0].headers.get("x-aicode-trajectory-id"), "override-session")
  assert.equal(f.requests[0].signal.aborted, false)
  override.abort()
  assert.equal(f.requests[0].signal.aborted, true)
})

test("an empty init header list replaces rather than merges Request headers", async (t) => {
  const f = await fixture(t)
  await assertAnswer(await f.fetch(new Request(endpoint, {
    method: "POST", headers: { "x-aicode-trajectory-id": "discarded-session" }, body: JSON.stringify(inputBody),
  }), { headers: [] }))
  assert.match(f.requests[0].headers.get("x-aicode-trajectory-id"), /^[0-9a-f]{8}-[0-9a-f-]{27}$/)
  assert.notEqual(f.requests[0].headers.get("x-aicode-trajectory-id"), "discarded-session")
})

test("uses the overriding method and rejects non-POST inference before native or upstream work", async (t) => {
  const f = await fixture(t)
  const response = await f.fetch(new Request(endpoint, { method: "POST", body: JSON.stringify(inputBody) }), { method: "PUT" })
  assert.equal(response.status, 405)
  assert.match((await response.json()).error.message, /POST/)
  assert.equal(f.profiles.length, 0)
  assert.equal(f.requests.length, 0)
})

test("pre-aborted inherited and overriding signals reject before reading a body or native credentials", async (t) => {
  const f = await fixture(t)
  const controller = new AbortController()
  const reason = new Error("Cancelled before sending")
  controller.abort(reason)
  const inherited = new Request(endpoint, { method: "POST", body: "invalid JSON", signal: controller.signal })
  await assert.rejects(f.fetch(inherited), (error) => error === reason)
  await assert.rejects(f.fetch(new Request(endpoint, { method: "POST", body: "invalid JSON" }), { signal: controller.signal }), (error) => error === reason)
  await assert.rejects(f.fetch(new URL(endpoint), { method: "POST", body: "invalid JSON", signal: controller.signal }), (error) => error === reason)
  assert.equal(f.profiles.length, 0)
  assert.equal(f.requests.length, 0)
})

test("aborting while reading a Request body cancels the source and rejects promptly", { timeout: 5000 }, async (t) => {
  const f = await fixture(t)
  const reading = deferred()
  const cancelled = deferred()
  let first = true
  const body = new ReadableStream({
    pull(controller) {
      if (first) {
        first = false
        controller.enqueue(encoder.encode('{"contents":['))
      } else {
        reading.resolve()
        return new Promise(() => {})
      }
    },
    cancel(reason) { cancelled.resolve(reason) },
  })
  const controller = new AbortController()
  const reason = new Error("Cancelled during the body read")
  const request = new Request(endpoint, { method: "POST", body, signal: controller.signal, duplex: "half" })
  const pending = f.fetch(request)
  await reading.promise
  controller.abort(reason)
  await assert.rejects(pending, (error) => error === reason)
  assert.equal(await cancelled.promise, reason)
  assert.equal(f.profiles.length, 0)
  assert.equal(f.requests.length, 0)
})

test("passes the inherited signal through to nonstream response aggregation", { timeout: 5000 }, async (t) => {
  const reading = deferred()
  const cancelled = deferred()
  const upstream = new Response(new ReadableStream({
    pull() { reading.resolve(); return new Promise(() => {}) },
    cancel(reason) { cancelled.resolve(reason) },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })
  const f = await fixture(t, [upstream])
  const controller = new AbortController()
  const reason = new Error("Cancelled during the response read")
  const pending = f.fetch(new Request(endpoint, { method: "POST", body: JSON.stringify(inputBody), signal: controller.signal }))
  await reading.promise
  controller.abort(reason)
  await assert.rejects(pending, (error) => error === reason)
  assert.equal(await cancelled.promise, reason)
  assert.equal(f.requests[0].signal.aborted, true)
})

test("renews an upstream 401 once and reuses the bound trajectory and payload", async (t) => {
  const rejected = json({ error: { message: "Expired access token" } }, 401)
  const f = await fixture(t, [rejected, sse(), sse(), sse()])
  await assertAnswer(await f.fetch(endpoint, {
    method: "POST", headers: { "x-aicode-trajectory-id": "retry-session" }, body: JSON.stringify(inputBody),
  }))
  assert.equal(rejected.bodyUsed, true)
  assert.equal(f.requests.length, 2)
  assert.deepEqual(f.profiles.map((options) => options.forceRefresh), [false, true])
  assert.deepEqual(f.requests[0].payload, f.requests[1].payload)
  assert.deepEqual(f.requests.map((request) => request.headers.get("authorization")), ["Bearer native-access", "Bearer renewed-access"])
  assert.deepEqual(f.requests.map((request) => request.headers.get("x-aicode-trajectory-id")), ["retry-session", "retry-session"])
  assert.deepEqual(f.requests.map((request) => request.headers.get("x-aicode-request-id")), ["retry-session-0", "retry-session-1"])
  await assertAnswer(await f.fetch(endpoint, {
    method: "POST", headers: { "x-aicode-trajectory-id": "independent-session" }, body: JSON.stringify(inputBody),
  }))
  await assertAnswer(await f.fetch(endpoint, {
    method: "POST", headers: { "x-aicode-trajectory-id": "retry-session" }, body: JSON.stringify(inputBody),
  }))
  assert.deepEqual(f.requests.map((request) => request.headers.get("x-aicode-request-id")), ["retry-session-0", "retry-session-1", "independent-session-0", "retry-session-2"])
})

test("a second upstream 401 is returned without a third inference attempt", async (t) => {
  const body = { error: { message: "Still unauthenticated" } }
  const second = json(body, 401, { "retry-after": "19" })
  const f = await fixture(t, [json({ error: { message: "Expired token" } }, 401), second])
  const response = await f.fetch(endpoint, { method: "POST", body: JSON.stringify(inputBody) })
  assert.equal(response, second)
  assert.equal(response.status, 401)
  assert.equal(response.headers.get("retry-after"), "19")
  assert.deepEqual(await response.json(), body)
  assert.equal(f.requests.length, 2)
  assert.deepEqual(f.profiles.map((options) => options.forceRefresh), [false, true])
})

test("an upstream administrator 403 preserves its response and never refreshes or replays", async (t) => {
  const body = { error: { code: 403, message: "The administrator has not enabled this model", status: "PERMISSION_DENIED" } }
  const upstream = new Response(JSON.stringify(body), { status: 403, statusText: "Forbidden", headers: { "content-type": "application/json", "retry-after": "23" } })
  const f = await fixture(t, [upstream])
  const response = await f.fetch(endpoint, { method: "POST", body: JSON.stringify(inputBody) })
  assert.equal(response, upstream)
  assert.equal(response.status, 403)
  assert.equal(response.statusText, "Forbidden")
  assert.equal(response.headers.get("retry-after"), "23")
  assert.deepEqual(await response.json(), body)
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.profiles.map((options) => options.forceRefresh), [false])
})

test("a changed native account remains an authentication failure before inference", async (t) => {
  const f = await fixture(t, [], { binding: "another-native-account" })
  const response = await f.fetch(endpoint, { method: "POST", body: JSON.stringify(inputBody) })
  assert.equal(response.status, 401)
  assert.equal(response.headers.get("x-magpie-sign-in"), "expired")
  assert.match((await response.json()).error.message, /account signed in to Antigravity changed/)
  assert.equal(f.requests.length, 0)
})

test("provided trajectories number interleaved conversations independently", async (t) => {
  const f = await fixture(t, [sse(), sse(), sse()])
  for (const id of ["conversation-a", "conversation-b", "conversation-a"]) {
    await assertAnswer(await f.fetch(endpoint, {
      method: "POST", headers: { "x-aicode-trajectory-id": id }, body: JSON.stringify(inputBody),
    }))
  }
  assert.deepEqual(f.requests.map((request) => request.headers.get("x-aicode-request-id")), ["conversation-a-0", "conversation-b-0", "conversation-a-1"])
})

test("generated trajectories number interleaved conversations independently", async (t) => {
  const f = await fixture(t, [sse(), sse(), sse()])
  for (const text of ["Conversation A", "Conversation B", "Conversation A"]) {
    await assertAnswer(await f.fetch(endpoint, {
      method: "POST", body: JSON.stringify({ contents: [{ role: "user", parts: [{ text }] }] }),
    }))
  }
  const ids = f.requests.map((request) => request.headers.get("x-aicode-trajectory-id"))
  assert.match(ids[0], /^[0-9a-f]{8}-[0-9a-f-]{27}$/)
  assert.match(ids[1], /^[0-9a-f]{8}-[0-9a-f-]{27}$/)
  assert.notEqual(ids[0], ids[1])
  assert.equal(ids[2], ids[0])
  assert.deepEqual(f.requests.map((request) => request.headers.get("x-aicode-request-id")), [`${ids[0]}-0`, `${ids[1]}-0`, `${ids[0]}-1`])
})

test("a generated trajectory keeps its counter when supplied explicitly", async (t) => {
  const f = await fixture(t, [sse(), sse(), sse()])
  await assertAnswer(await f.fetch(endpoint, { method: "POST", body: JSON.stringify(inputBody) }))
  const id = f.requests[0].headers.get("x-aicode-trajectory-id")
  await assertAnswer(await f.fetch(endpoint, {
    method: "POST", headers: { "x-aicode-trajectory-id": id }, body: JSON.stringify(inputBody),
  }))
  await assertAnswer(await f.fetch(endpoint, { method: "POST", body: JSON.stringify(inputBody) }))
  assert.deepEqual(f.requests.map((request) => request.headers.get("x-aicode-request-id")), [`${id}-0`, `${id}-1`, `${id}-2`])
})

for (const supplied of [false, true]) {
  test(`${supplied ? "provided" : "generated"} trajectory counters isolate account, project, and location`, async (t) => {
    const f = await fixture(t, [sse(), sse(), sse(), sse(), sse()])
    const original = { ...f.metadata }
    const scopes = [
      original,
      { ...original, projectId: "another-licensed-project" },
      { ...original, location: "us" },
      { ...original, nativeBinding: "another-native-account" },
      original,
    ]
    for (const scope of scopes) {
      Object.assign(f.metadata, scope)
      f.native.binding = () => scope.nativeBinding
      await assertAnswer(await f.fetch(endpoint, {
        method: "POST", headers: supplied ? { "x-aicode-trajectory-id": "shared-trajectory" } : {}, body: JSON.stringify(inputBody),
      }))
    }
    const ids = f.requests.map((request) => request.headers.get("x-aicode-trajectory-id"))
    assert.equal(new Set(ids.slice(0, 4)).size, supplied ? 1 : 4)
    assert.equal(ids[4], ids[0])
    assert.deepEqual(f.requests.map((request) => request.headers.get("x-aicode-request-id")), ids.map((id, index) => `${id}-${index === 4 ? 1 : 0}`))
  })

  test(`${supplied ? "explicit" : "generated"} trajectory resumes from full history without moving its counter backward`, async (t) => {
    const f = await fixture(t, [sse(), sse(), sse()])
    const modelTurn = { role: "model", parts: [{ text: "Earlier answer" }] }
    const history = {
      contents: [
        ...inputBody.contents,
        { role: "model", parts: [{ functionCall: { name: "read_file", args: { path: "example.txt" } } }] },
        { role: "model", parts: [{ functionResponse: { name: "read_file", response: { content: "File contents" } } }] },
        modelTurn,
        { role: "user", parts: [{ text: "Continue this conversation" }] },
      ],
    }
    for (const body of [history, inputBody, { contents: [...history.contents, modelTurn, modelTurn] }]) {
      await assertAnswer(await f.fetch(endpoint, {
        method: "POST", headers: supplied ? { "x-aicode-trajectory-id": "resumed-trajectory" } : {}, body: JSON.stringify(body),
      }))
    }
    const id = f.requests[0].headers.get("x-aicode-trajectory-id")
    if (supplied) assert.equal(id, "resumed-trajectory")
    assert.deepEqual(f.requests.map((request) => request.headers.get("x-aicode-trajectory-id")), [id, id, id])
    assert.deepEqual(f.requests.map((request) => request.headers.get("x-aicode-request-id")), [`${id}-2`, `${id}-3`, `${id}-4`])
  })
}

test("tool response only model messages do not count as prior generations", async (t) => {
  const f = await fixture(t, [sse(), sse()])
  const toolResult = { functionResponse: { name: "read_file", response: { content: "File contents" } } }
  const history = [
    ...inputBody.contents,
    { role: "model", parts: [toolResult] },
    { role: "model", parts: [toolResult, toolResult] },
    { role: "model", parts: [] },
    { role: "user", parts: [toolResult] },
  ]
  for (const contents of [history, [...history, { role: "model", parts: [toolResult, { text: "A generated answer" }] }]]) {
    await assertAnswer(await f.fetch(endpoint, {
      method: "POST", headers: { "x-aicode-trajectory-id": "tool-results" }, body: JSON.stringify({ contents }),
    }))
  }
  assert.deepEqual(f.requests.map((request) => request.headers.get("x-aicode-request-id")), ["tool-results-0", "tool-results-1"])
})

test("caller labels and model payload pass through with the actual app identity", async (t) => {
  const f = await fixture(t)
  const body = {
    ...inputBody,
    systemInstruction: { parts: [{ text: "Use the supplied context" }] },
    generationConfig: { temperature: 0.3, maxOutputTokens: 123 },
    labels: { cascade_id: "caller-cascade", root_cascade_id: "caller-root", custom_label: "caller-value" },
  }
  await assertAnswer(await f.fetch(endpoint, {
    method: "POST",
    headers: { "x-aicode-trajectory-id": "caller-trajectory", "user-agent": "caller-user-agent", accept: "text/event-stream", "accept-encoding": "identity" },
    body: JSON.stringify(body),
  }))
  const sent = f.requests[0]
  assert.deepEqual(sent.payload, { ...body, aicode: { experience: "gemini-3.8-flash-low" }, entitlement: { userTier: "licensed-tier" } })
  assert.equal(sent.headers.get("user-agent"), "antigravity/native-test-client")
  assert.equal(sent.headers.get("accept"), null)
  assert.equal(sent.headers.get("accept-encoding"), "gzip")
})

test("native tool turns increment once and newer full history raises the counter lower bound", async (t) => {
  const f = await fixture(t, [sse(), sse(), sse(), sse()])
  const toolHistory = [
    ...inputBody.contents,
    { role: "model", parts: [{ functionCall: { name: "read_file", args: { path: "example.txt" } } }] },
    { role: "model", parts: [{ functionResponse: { name: "read_file", response: { content: "File contents" } } }] },
  ]
  const resumedHistory = [
    ...toolHistory,
    { role: "model", parts: [{ text: "The file contains the requested information" }] },
    { role: "user", parts: [{ text: "Explain the result" }] },
    { role: "model", parts: [{ text: "An explanation from another process" }] },
    { role: "user", parts: [{ text: "Continue" }] },
  ]
  for (const contents of [inputBody.contents, toolHistory, resumedHistory, inputBody.contents]) {
    await assertAnswer(await f.fetch(endpoint, {
      method: "POST", headers: { "x-aicode-trajectory-id": "tool-conversation" }, body: JSON.stringify({ contents }),
    }))
  }
  assert.deepEqual(f.requests.map((request) => request.headers.get("x-aicode-request-id")), ["tool-conversation-0", "tool-conversation-1", "tool-conversation-3", "tool-conversation-4"])
})

const quotaProvider = { models: { "gemini-3.8-flash-low": { id: "gemini-3.8-flash-low" }, "claude-sonnet-4-5": { id: "claude-sonnet-4-5" } } }
const quotaSummary = { groups: [{ displayName: "All Models", buckets: [
  { bucketId: "gemini-3.8-flash-low", displayName: "Gemini Flash Low", remainingFraction: 0 },
  { bucketId: "claude-sonnet-4-5", displayName: "Claude Sonnet", remainingFraction: 1 },
] }] }

test("quota usage queries the saved selected license project with bound native identity", async (t) => {
  const f = await fixture(t, [json(quotaSummary)])
  f.metadata.tierDisplayName = "Verified Enterprise Tier"
  const profile = f.native.profile
  f.native.profile = async (options) => ({
    ...await profile(options), project_id: "native-default-project", region: "global",
    user_tier: "native-profile-tier", tier_display_name: "Native profile tier",
  })
  const result = await f.plugin.auth.usage(async () => ({ type: "api", metadata: f.metadata }), { models: {} })
  assert.equal(result.plan, "Verified Enterprise Tier")
  assert.equal(Object.hasOwn(result, "signIn"), false)
  assert.deepEqual(result.windows.map(({ used, models }) => ({ used, models })), [
    { used: 100, models: ["gemini-3.8-flash-low"] },
    { used: 0, models: ["claude-sonnet-4-5"] },
  ])
  assert.equal(f.requests.length, 1)
  const sent = f.requests[0]
  assert.equal(sent.url, "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary")
  assert.equal(sent.method, "POST")
  assert.deepEqual(sent.payload, { project: "licensed-project" })
  assert.equal(sent.headers.get("authorization"), "Bearer native-access")
  assert.equal(sent.headers.get("user-agent"), "antigravity/native-test-client")
  assert.equal(sent.headers.get("content-type"), "application/json")
  assert.equal(f.profiles[0].config, f.metadata)
  assert.equal(f.profiles[0].signal, sent.signal)
  assert.equal(f.profiles[0].forceRefresh, false)
})

test("quota usage reads each supplied account afresh instead of retaining loader auth", async (t) => {
  const f = await fixture(t, [json({ groups: [] }), json({ groups: [] })])
  const secondMetadata = { ...f.metadata, projectId: "second-licensed-project", location: "us", userTier: "second-tier" }
  let auth = { type: "api", metadata: f.metadata }
  const first = await f.plugin.auth.usage(async () => auth, quotaProvider)
  auth = { type: "api", metadata: secondMetadata }
  const second = await f.plugin.auth.usage(async () => auth, quotaProvider)
  assert.equal(first.plan, "licensed-tier")
  assert.equal(second.plan, "second-tier")
  assert.deepEqual(f.requests.map((request) => request.payload), [{ project: "licensed-project" }, { project: "second-licensed-project" }])
  assert.deepEqual(f.profiles.map((options) => options.config), [f.metadata, secondMetadata])
  assert.deepEqual(first.windows, [])
  assert.deepEqual(second.windows, [])
})

test("quota usage reports missing auth and account binding changes as expired without requests", async (t) => {
  const f = await fixture(t, [], { binding: "other-account" })
  for (const auth of [undefined, { type: "api" }, { type: "oauth", metadata: f.metadata }]) {
    const result = await f.plugin.auth.usage(async () => auth, quotaProvider)
    assert.equal(result.signIn, "expired")
    assert.match(result.error, /Sign in with the local Antigravity enterprise account/)
    assert.equal(Object.hasOwn(result, "windows"), false)
  }
  assert.equal(f.profiles.length, 0)
  const changed = await f.plugin.auth.usage(async () => ({ type: "api", metadata: f.metadata }), quotaProvider)
  assert.equal(changed.signIn, "expired")
  assert.match(changed.error, /account signed in to Antigravity changed/)
  assert.equal(f.requests.length, 0)
})

test("quota renews a rejected token once and returns real usage for the saved account", async (t) => {
  const rejected = json({ error: { message: "private rejected-token detail" } }, 401)
  const f = await fixture(t, [rejected, json(quotaSummary)])
  const profile = f.native.profile
  f.native.profile = async (options) => {
    if (options.forceRefresh) assert.equal(rejected.bodyUsed, true)
    return profile(options)
  }
  const result = await f.plugin.auth.usage(async () => ({ type: "api", metadata: f.metadata }), quotaProvider)
  assert.equal(result.plan, "licensed-tier")
  assert.notEqual(result.signIn, "expired")
  assert.equal(Object.hasOwn(result, "error"), false)
  assert.deepEqual(result.windows.map(({ used, models }) => ({ used, models })), [
    { used: 100, models: ["gemini-3.8-flash-low"] },
    { used: 0, models: ["claude-sonnet-4-5"] },
  ])
  assert.equal(f.requests.length, 2)
  assert.deepEqual(f.requests.map((request) => request.payload), [{ project: "licensed-project" }, { project: "licensed-project" }])
  assert.deepEqual(f.requests.map((request) => request.headers.get("authorization")), ["Bearer native-access", "Bearer renewed-access"])
  assert.deepEqual(f.profiles.map((options) => options.forceRefresh), [false, true])
  assert.ok(f.profiles.every((options) => options.config === f.metadata && options.signal === f.requests[0].signal))
})

test("a second quota 401 expires auth after exactly one renewal without exposing its body", async (t) => {
  const secret = "private credential detail"
  const f = await fixture(t, [json({ error: { message: secret } }, 401), json({ error: { message: secret } }, 401)])
  const result = await f.plugin.auth.usage(async () => ({ type: "api", metadata: f.metadata }), quotaProvider)
  assert.equal(result.signIn, "expired")
  assert.match(result.error, /HTTP 401/)
  assert.equal(result.error.includes(secret), false)
  assert.equal(Object.hasOwn(result, "windows"), false)
  assert.equal(f.requests.length, 2)
  assert.deepEqual(f.profiles.map((options) => options.forceRefresh), [false, true])
})

test("quota 403 preserves auth without refreshing, replaying, or exposing its body", async (t) => {
  const secret = "private administrator detail"
  const f = await fixture(t, [json({ error: { message: secret } }, 403)])
  const result = await f.plugin.auth.usage(async () => ({ type: "api", metadata: f.metadata }), quotaProvider)
  assert.equal(result.signIn, "kept")
  assert.match(result.error, /HTTP 403/)
  assert.equal(result.error.includes(secret), false)
  assert.equal(Object.hasOwn(result, "windows"), false)
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.profiles.map((options) => options.forceRefresh), [false])
})

test("quota network, JSON, and structural failures preserve auth and unknown usage", async (t) => {
  const failures = [
    [new TypeError("Network unavailable"), /Network unavailable/],
    [new Response("not JSON", { status: 200 }), /invalid JSON response/],
    [json({ groups: {} }), /invalid groups list/],
  ]
  for (const [response, message] of failures) {
    const f = await fixture(t, [response])
    const result = await f.plugin.auth.usage(async () => ({ type: "api", metadata: f.metadata }), quotaProvider)
    assert.equal(result.signIn, "kept")
    assert.match(result.error, message)
    assert.equal(Object.hasOwn(result, "windows"), false)
    assert.equal(f.requests.length, 1)
  }
})

test("native auth failures retain their explicit expired or kept sign-in state", async (t) => {
  for (const signIn of ["expired", undefined]) {
    const f = await fixture(t, [])
    f.native.profile = async () => { throw Object.assign(new Error("Native authentication could not be read"), { signIn }) }
    const result = await f.plugin.auth.usage(async () => ({ type: "api", metadata: f.metadata }), quotaProvider)
    assert.equal(result.signIn, signIn ?? "kept")
    assert.match(result.error, /Native authentication could not be read/)
    assert.equal(Object.hasOwn(result, "windows"), false)
    assert.equal(f.requests.length, 0)
  }
})

test("pre-aborted quota reads reject before auth or native work", async (t) => {
  const f = await fixture(t, [])
  const controller = new AbortController()
  const reason = new Error("Cancelled before quota")
  controller.abort(reason)
  let authReads = 0
  await assert.rejects(f.plugin.auth.usage(async () => { authReads++; return { type: "api", metadata: f.metadata } }, quotaProvider, { signal: controller.signal }), (error) => error === reason)
  assert.equal(authReads, 0)
  assert.equal(f.profiles.length, 0)
  assert.equal(f.requests.length, 0)
})

test("cancelling quota while getAuth is pending rejects promptly and prevents later work", async (t) => {
  const f = await fixture(t, [])
  const pendingAuth = deferred()
  const entered = deferred()
  const controller = new AbortController()
  const reason = new Error("Cancelled while reading account")
  const result = f.plugin.auth.usage(() => { entered.resolve(); return pendingAuth.promise }, quotaProvider, { signal: controller.signal })
  await entered.promise
  controller.abort(reason)
  await assert.rejects(result, (error) => error === reason)
  pendingAuth.resolve({ type: "api", metadata: f.metadata })
  await pendingAuth.promise
  assert.equal(f.profiles.length, 0)
  assert.equal(f.requests.length, 0)
})

test("cancelling quota during native binding propagates the same bounded signal", async (t) => {
  const f = await fixture(t, [])
  const pendingProfile = deferred()
  const entered = deferred()
  const controller = new AbortController()
  f.native.profile = (options) => { entered.resolve(options); return pendingProfile.promise }
  const result = f.plugin.auth.usage(async () => ({ type: "api", metadata: f.metadata }), quotaProvider, { signal: controller.signal })
  const options = await entered.promise
  assert.equal(options.config, f.metadata)
  const reason = new Error("Cancelled while binding native account")
  controller.abort(reason)
  await assert.rejects(result, (error) => error === reason)
  assert.equal(options.signal.aborted, true)
  assert.equal(options.signal.reason, reason)
  pendingProfile.resolve({ token: { access_token: "native-access" } })
  await pendingProfile.promise
  assert.equal(f.requests.length, 0)
})

test("one overall 30-second quota deadline includes identity and the upstream request", async (t) => {
  const deadline = new AbortController()
  const delays = []
  t.mock.method(AbortSignal, "timeout", (milliseconds) => { delays.push(milliseconds); return deadline.signal })
  const pendingResponse = deferred()
  const enteredRequest = deferred()
  const f = await fixture(t, [pendingResponse.promise], { onRequest: enteredRequest.resolve })
  const pendingIdentity = deferred()
  const enteredIdentity = deferred()
  f.native.identity = () => { enteredIdentity.resolve(); return pendingIdentity.promise }
  const controller = new AbortController()
  const result = f.plugin.auth.usage(async () => ({ type: "api", metadata: f.metadata }), quotaProvider, { signal: controller.signal })
  await enteredIdentity.promise
  assert.deepEqual(delays, [30_000])
  const signal = f.profiles[0].signal
  assert.equal(signal.aborted, false)
  pendingIdentity.resolve("antigravity/native-test-client")
  await enteredRequest.promise
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].signal, signal)
  const reason = new DOMException("Quota deadline exceeded", "TimeoutError")
  deadline.abort(reason)
  await assert.rejects(result, (error) => error === reason)
  assert.equal(signal.aborted, true)
  assert.deepEqual(delays, [30_000])
  pendingResponse.resolve(json({ groups: [] }))
})

test("cancelling quota during header identity lookup never starts an upstream request", async (t) => {
  const f = await fixture(t, [])
  const pendingIdentity = deferred()
  const entered = deferred()
  f.native.identity = () => { entered.resolve(); return pendingIdentity.promise }
  const controller = new AbortController()
  const result = f.plugin.auth.usage(async () => ({ type: "api", metadata: f.metadata }), quotaProvider, { signal: controller.signal })
  await entered.promise
  controller.abort()
  await assert.rejects(result, { name: "AbortError" })
  pendingIdentity.resolve("antigravity/native-test-client")
  await pendingIdentity.promise
  await Promise.resolve()
  assert.equal(f.requests.length, 0)
})

test("quota cancellation covers a response body that has not finished parsing", async (t) => {
  const parsing = deferred()
  let source
  const response = new Response(new ReadableStream({
    start(controller) { source = controller; controller.enqueue(encoder.encode('{"groups":')) },
    pull() { parsing.resolve() },
  }), { headers: { "content-type": "application/json" } })
  const f = await fixture(t, [response])
  const controller = new AbortController()
  const result = f.plugin.auth.usage(async () => ({ type: "api", metadata: f.metadata }), quotaProvider, { signal: controller.signal })
  await parsing.promise
  controller.abort()
  await assert.rejects(result, { name: "AbortError" })
  source.error(new DOMException("Response aborted", "AbortError"))
})

test("cancelling quota during forced renewal prevents a replay even when credentials arrive later", async (t) => {
  const rejected = json({ error: { message: "Expired token" } }, 401)
  const f = await fixture(t, [rejected])
  const pendingProfile = deferred()
  const enteredRenewal = deferred()
  const profile = f.native.profile
  f.native.profile = (options) => {
    if (!options.forceRefresh) return profile(options)
    assert.equal(rejected.bodyUsed, true)
    enteredRenewal.resolve(options)
    return pendingProfile.promise
  }
  const controller = new AbortController()
  const result = f.plugin.auth.usage(async () => ({ type: "api", metadata: f.metadata }), quotaProvider, { signal: controller.signal })
  const renewal = await enteredRenewal.promise
  assert.equal(renewal.signal, f.requests[0].signal)
  const reason = new Error("Cancelled quota renewal")
  controller.abort(reason)
  await assert.rejects(result, (error) => error === reason)
  pendingProfile.resolve({ token: { access_token: "late-token" } })
  await pendingProfile.promise
  await Promise.resolve()
  assert.equal(f.requests.length, 1)
})

test("quota retry shares the original deadline through renewal and its second request", async (t) => {
  const deadline = new AbortController()
  const delays = []
  t.mock.method(AbortSignal, "timeout", (milliseconds) => { delays.push(milliseconds); return deadline.signal })
  const pendingResponse = deferred()
  const replayed = deferred()
  const f = await fixture(t, [json({}, 401), pendingResponse.promise], { onRequest(request) {
    if (request.headers.get("authorization") === "Bearer renewed-access") replayed.resolve()
  } })
  const result = f.plugin.auth.usage(async () => ({ type: "api", metadata: f.metadata }), quotaProvider)
  await replayed.promise
  assert.deepEqual(delays, [30_000])
  assert.equal(f.requests.length, 2)
  assert.ok(f.requests.every((request) => request.signal === deadline.signal))
  assert.ok(f.profiles.every((options) => options.signal === deadline.signal))
  const reason = new DOMException("Quota retry deadline exceeded", "TimeoutError")
  deadline.abort(reason)
  await assert.rejects(result, (error) => error === reason)
  pendingResponse.resolve(json(quotaSummary))
})

test("quota renewal rejects an account switch before replaying the selected project's request", async (t) => {
  const f = await fixture(t, [json({}, 401)])
  const profile = f.native.profile
  f.native.profile = async (options) => ({ ...await profile(options), account: options.forceRefresh ? "other-account" : "native-account" })
  f.native.binding = (profile) => profile.account
  const result = await f.plugin.auth.usage(async () => ({ type: "api", metadata: f.metadata }), quotaProvider)
  assert.equal(result.signIn, "expired")
  assert.match(result.error, /account signed in to Antigravity changed/)
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.profiles.map((options) => options.forceRefresh), [false, true])
})

test("the model catalog renews once using the saved project's location and license tier", async (t) => {
  const rejected = json({}, 401)
  const f = await fixture(t, [rejected, json({ models: { "licensed-model": { displayName: "Licensed model", maxTokens: 1000 } } })])
  const models = await f.plugin.provider.models({}, { auth: { type: "api", metadata: f.metadata } })
  assert.deepEqual(Object.keys(models), ["licensed-model"])
  assert.equal(models["licensed-model"].name, "Licensed model")
  assert.equal(models["licensed-model"].limit.context, 1000)
  assert.equal(rejected.bodyUsed, true)
  assert.equal(f.requests.length, 2)
  assert.ok(f.requests.every((request) => request.url === "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels"))
  assert.deepEqual(f.requests.map((request) => request.payload), [
    { project: "licensed-project", location: "eu", entitlement: { userTier: "licensed-tier" } },
    { project: "licensed-project", location: "eu", entitlement: { userTier: "licensed-tier" } },
  ])
  assert.deepEqual(f.requests.map((request) => request.headers.get("authorization")), ["Bearer native-access", "Bearer renewed-access"])
  assert.deepEqual(f.profiles.map((options) => options.forceRefresh), [false, true])
  assert.ok(f.profiles.every((options) => options.config === f.metadata && options.signal === f.requests[0].signal))
})

test("catalog authorization failures stop after the permitted renewal without exposing response bodies", async (t) => {
  for (const status of [401, 403]) {
    const secret = "private catalog authorization detail"
    const responses = Array.from({ length: status === 401 ? 2 : 1 }, () => json({ error: { message: secret } }, status))
    const f = await fixture(t, responses)
    await assert.rejects(f.plugin.provider.models({}, { auth: { type: "api", metadata: f.metadata } }), (error) => {
      assert.match(error.message, new RegExp(`HTTP ${status}`))
      assert.equal(error.message.includes(secret), false)
      assert.equal(error.signIn, status === 401 ? "expired" : "kept")
      return true
    })
    assert.equal(f.requests.length, responses.length)
    assert.deepEqual(f.profiles.map((options) => options.forceRefresh), status === 401 ? [false, true] : [false])
  }
})

test("catalog renewal rejects a changed account before replaying its entitlement", async (t) => {
  const f = await fixture(t, [json({}, 401)])
  const profile = f.native.profile
  f.native.profile = async (options) => ({ ...await profile(options), account: options.forceRefresh ? "other-account" : "native-account" })
  f.native.binding = (profile) => profile.account
  await assert.rejects(f.plugin.provider.models({}, { auth: { type: "api", metadata: f.metadata } }), (error) => error.signIn === "expired" && /account signed in to Antigravity changed/.test(error.message))
  assert.equal(f.requests.length, 1)
})

async function signInFixture(responses, { renewedBinding = "signing-account" } = {}) {
  const sessions = []
  const profiles = []
  const requests = []
  const createNativeSession = () => {
    const owner = sessions.length
    let unlocked = false
    const session = {
      async profile(options = {}) {
        profiles.push({ owner, ...options })
        options.signal?.throwIfAborted()
        if (!unlocked && !options.interactive) throw new Error("Explicit Keychain access is required")
        unlocked = true
        return {
          owner, account: options.forceRefresh ? renewedBinding : "signing-account",
          project_id: "licensed-project", region: "eu",
          token: { access_token: `${options.forceRefresh ? "renewed" : "native"}-${owner}` },
        }
      },
      binding: (profile) => profile.account,
      async identity(profile) {
        assert.equal(profile.owner, owner, "The signing account's session must build its own identity")
        return `antigravity/account-${owner}`
      },
    }
    sessions.push(session)
    return session
  }
  const fetch = async (url, init) => {
    requests.push({ url, ...init, headers: new Headers(init.headers) })
    const response = responses[requests.length - 1]
    assert.ok(response, "An unexpected sign-in request was made")
    return response
  }
  const plugin = await AntigravityEnterprisePlugin({}, { _deps: { createNativeSession, fetch } })
  return { plugin, method: plugin.auth.methods.find((method) => method.type === "api"), sessions, profiles, requests }
}

test("explicit login can unlock Keychain and renew licenses with its own account session", async () => {
  const rejected = json({}, 401)
  const f = await signInFixture([rejected, json({ licenses: [
    { projectId: "other-project", location: "eu", userTier: "unrelated-tier" },
    { projectId: "licensed-project", location: "eu", userTier: "selected-tier", tierDisplayName: "Selected enterprise" },
  ] }), json({ models: { "signed-in-model": { displayName: "Signed in model" } } })])
  const prompt = await f.method.ask()
  assert.equal(prompt.key, "projectId")
  assert.equal(prompt.placeholder, "licensed-project")
  const result = await f.method.authorize({ projectId: "licensed-project", location: "eu", authMethod: "auto" })
  assert.equal(result.type, "success")
  assert.equal(result.key, "native-keychain:signing-account")
  assert.equal(result.metadata.nativeBinding, "signing-account")
  assert.equal(result.metadata.userTier, "selected-tier")
  assert.equal(result.metadata.tierDisplayName, "Selected enterprise")
  assert.equal(rejected.bodyUsed, true)
  assert.deepEqual(f.requests.map((request) => request.headers.get("authorization")), ["Bearer native-1", "Bearer renewed-1"])
  assert.ok(f.requests.every((request) => request.url.endsWith(":fetchLicenses") && request.headers.get("user-agent") === "antigravity/account-1"))
  assert.deepEqual(f.profiles.filter((options) => options.owner === 1).map((options) => [options.forceRefresh ?? false, options.interactive]), [[false, true], [true, true]])
  const models = await f.plugin.provider.models({}, { auth: { type: "api", metadata: result.metadata } })
  assert.deepEqual(Object.keys(models), ["signed-in-model"])
  assert.equal(f.requests[2].headers.get("user-agent"), "antigravity/account-1")
  assert.equal(f.profiles.at(-1).interactive, false)
})

test("license renewal cannot bind a different native account or an unrelated project and location", async () => {
  for (const [renewedBinding, license, message] of [
    ["other-account", { projectId: "licensed-project", location: "eu", userTier: "tier" }, /account signed in to Antigravity changed/],
    ["signing-account", { projectId: "other-project", location: "eu", userTier: "tier" }, /no enterprise license/],
    ["signing-account", { projectId: "licensed-project", location: "us", userTier: "tier" }, /no enterprise license/],
  ]) {
    const f = await signInFixture([json({}, 401), json({ licenses: [license] })], { renewedBinding })
    const result = await f.method.authorize({ projectId: "licensed-project", location: "eu", authMethod: "auto" })
    assert.equal(result.type, "failed")
    assert.match(result.error, message)
    assert.equal(f.requests.length, renewedBinding === "other-account" ? 1 : 2)
    assert.deepEqual(f.profiles.map((options) => options.forceRefresh ?? false), [false, true])
  }
})

test("license 401 renews only once and license 403 never renews or exposes private error detail", async () => {
  for (const status of [401, 403]) {
    const secret = "private license authorization detail"
    const responses = Array.from({ length: status === 401 ? 2 : 1 }, () => json({ error: { message: secret } }, status))
    const f = await signInFixture(responses)
    const result = await f.method.authorize({ projectId: "licensed-project", location: "eu", authMethod: "auto" })
    assert.equal(result.type, "failed")
    assert.match(result.error, new RegExp(`HTTP ${status}`))
    assert.equal(result.error.includes(secret), false)
    assert.equal(f.requests.length, responses.length)
    assert.deepEqual(f.profiles.map((options) => options.forceRefresh ?? false), status === 401 ? [false, true] : [false])
  }
})

const loginConfig = { projectId: "licensed-project", location: "eu", authMethod: "gcp" }
const loginToken = { access_token: "fresh-oauth-access", refresh_token: "fresh-oauth-refresh", expires_in: 3600, token_type: "Bearer", id_token: "private-id-token" }
const loginLicense = { projectId: "licensed-project", location: "eu", userTier: "enterprise-tier", tierDisplayName: "Enterprise license" }

async function browserSignInFixture({ storedRaw = null, responses = [json({ licenses: [loginLicense] })] } = {}) {
  const reads = [], installs = [], profiles = [], identities = [], requests = [], starts = [], sessions = []
  let credential = storedRaw
  const flow = { closed: 0, async wait() { return { ...loginToken } }, close() { this.closed++ } }
  const deps = {
    async readLoginCredential(stateDir, options) {
      reads.push({ stateDir, ...options })
      if (credential === null) throw Object.assign(new Error("No native account exists"), { code: "ERR_NATIVE_KEYCHAIN_MISSING" })
      return credential
    },
    async installLoginCredential(stateDir, expected, replacement, options) {
      installs.push({ stateDir, expected, replacement, ...options })
      if (credential !== expected) return false
      credential = replacement
      return true
    },
    async startEnterpriseLogin(config, options, context) {
      starts.push({ config, options, ...context })
      return { ...flow, url: "https://accounts.example.test/enterprise", wait: (...args) => flow.wait(...args), close: () => flow.close() }
    },
    createNativeSession() {
      const owner = sessions.length
      const session = {
        async profile(options) {
          profiles.push({ owner, ...options })
          options.signal?.throwIfAborted()
          assert.ok(installs.length, "Native credentials must only be resolved after a guarded install")
          const installed = JSON.parse(Buffer.from(credential.slice("go-keyring-base64:".length), "base64").toString())
          return { ...installed, _principal: "verified-new-principal" }
        },
        async identity(profile) {
          identities.push({ owner, profile: structuredClone(profile) })
          return `antigravity/browser-session-${owner}`
        },
        binding(profile) {
          assert.equal(profile._principal, "verified-new-principal")
          return "verified-new-binding"
        },
      }
      sessions.push(session)
      return session
    },
    async fetch(url, init) {
      requests.push({ url, ...init, headers: new Headers(init.headers) })
      const response = responses[requests.length - 1]
      assert.ok(response, "An unexpected browser sign-in request was made")
      return typeof response === "function" ? response() : response
    },
  }
  const plugin = await AntigravityEnterprisePlugin({}, { stateDir: "/private/login-state", _deps: deps })
  return { plugin, method: plugin.auth.methods.find((method) => method.type === "oauth"), reads, installs, profiles, identities, requests, starts, sessions, flow, deps,
    get credential() { return credential }, set credential(value) { credential = value } }
}

test("primary browser sign-in prompts without local credentials and starts a fresh install", async () => {
  const f = await browserSignInFixture()
  assert.equal(f.plugin.auth.methods[0], f.method)
  assert.equal(f.method.label, "Sign in with enterprise account")
  const inputs = {}
  for (const [key, value] of Object.entries(loginConfig)) {
    const prompt = await f.method.ask(inputs)
    assert.equal(prompt.key, key)
    if (key === "authMethod") assert.deepEqual(prompt.options.map((option) => option.value), ["gcp", "wif"])
    inputs[key] = value
  }
  assert.equal(await f.method.ask(inputs), null)
  assert.equal((await f.method.ask({ ...inputs, authMethod: "wif" })).key, "wifProvider")
  assert.equal(f.reads.length, 0)
  assert.equal(f.profiles.length, 0)
  const result = await f.method.authorize(inputs)
  assert.equal(result.url, "https://accounts.example.test/enterprise")
  assert.equal(result.method, "auto")
  assert.equal(result.opened, false)
  assert.match(result.instructions, /Complete/)
  assert.equal(f.reads.length, 1)
  assert.equal(f.reads[0].interactive, true)
  assert.equal(f.reads[0].stateDir, "/private/login-state")
  assert.deepEqual(f.starts[0].config, { ...loginConfig, wifProvider: "" })
  assert.equal(f.profiles.length, 0)
  assert.equal(f.installs.length, 0)
  await result.callback()
  assert.equal(f.flow.closed, 1)
})

test("fresh OAuth validates the exact license before installing a native profile and exposes only API reference metadata", async () => {
  const oldRaw = "previous raw credential need not decode"
  const f = await browserSignInFixture({ storedRaw: oldRaw, responses: [() => {
    assert.equal(f.installs.length, 0)
    assert.equal(f.profiles.length, 0)
    assert.equal(f.credential, oldRaw)
    return json({ licenses: [{ ...loginLicense, projectId: "unrelated-project" }, loginLicense] })
  }, json({ models: { "new-account-model": { displayName: "New account model" } } })] })
  const authorized = await f.method.authorize({ ...loginConfig, wifProvider: "ignored-for-gcp" })
  const earliestExpiry = Date.now() + 3_600_000
  const result = await authorized.callback()
  assert.equal(result.type, "success")
  assert.equal(result.key, "native-keychain:verified-new-binding")
  assert.equal(result.accountId, "licensed-project/eu/verified-new")
  assert.deepEqual(result.metadata, { ...loginConfig, wifProvider: "", nativeBinding: "verified-new-binding", userTier: "enterprise-tier", tierDisplayName: "Enterprise license" })
  assert.equal(f.installs.length, 1)
  assert.equal(f.installs[0].expected, oldRaw)
  assert.equal(f.installs[0].interactive, true)
  assert.equal(f.installs[0].stateDir, "/private/login-state")
  const installed = JSON.parse(Buffer.from(f.installs[0].replacement.slice("go-keyring-base64:".length), "base64").toString())
  assert.deepEqual({ ...installed, token: undefined }, { auth_method: "gcp", wif_provider: "", project_id: "licensed-project", region: "eu", user_tier: "enterprise-tier", tier_display_name: "Enterprise license", token: undefined })
  assert.deepEqual({ ...installed.token, expiry: undefined }, { access_token: "fresh-oauth-access", refresh_token: "fresh-oauth-refresh", token_type: "Bearer", expiry: undefined })
  assert.ok(Date.parse(installed.token.expiry) >= earliestExpiry)
  assert.ok(Date.parse(installed.token.expiry) <= Date.now() + 3_600_000)
  assert.equal(f.identities[0].profile.user_tier, "")
  assert.equal(Object.hasOwn(f.identities[0].profile, "_principal"), false)
  assert.equal(f.requests[0].headers.get("authorization"), "Bearer fresh-oauth-access")
  assert.equal(f.requests[0].headers.get("user-agent"), "antigravity/browser-session-0")
  assert.equal(f.profiles.length, 1)
  assert.equal(f.profiles[0].interactive, true)
  assert.equal(f.profiles[0].forceRefresh ?? false, false)
  assert.equal(f.flow.closed, 1)
  const serialized = JSON.stringify(result)
  for (const secret of Object.values(loginToken).filter((value) => typeof value === "string" && value !== "Bearer")) assert.equal(serialized.includes(secret), false)
  assert.equal(serialized.includes("go-keyring-base64:"), false)
  const models = await f.plugin.provider.models({}, { auth: { type: "api", metadata: result.metadata } })
  assert.deepEqual(Object.keys(models), ["new-account-model"])
  assert.equal(f.profiles.at(-1).owner, 0)
  assert.equal(f.profiles.at(-1).interactive, false)
})

test("fresh login rejects unrelated or denied licenses without installing credentials or renewing the previous account", async () => {
  for (const response of [
    json({ licenses: [{ ...loginLicense, projectId: "another-project" }] }),
    json({ licenses: [{ ...loginLicense, location: "us" }] }),
    json({ licenses: [{ ...loginLicense, userTier: "" }] }),
    json({ licenses: [{ ...loginLicense, userTier: 123 }] }),
    json({ error: { message: "private license secret" } }, 401),
    json({ error: { message: "private license secret" } }, 403),
  ]) {
    const f = await browserSignInFixture({ storedRaw: "old raw", responses: [response] })
    const result = await (await f.method.authorize(loginConfig)).callback()
    assert.equal(result.type, "failed")
    assert.equal(f.credential, "old raw")
    assert.equal(f.installs.length, 0)
    assert.equal(f.profiles.length, 0)
    assert.equal(f.requests.length, 1)
    assert.equal(f.flow.closed, 1)
    assert.equal(JSON.stringify(result).includes("private license secret"), false)
  }
})

test("guarded fresh login preserves an account that Antigravity changed during browser sign-in", async () => {
  const f = await browserSignInFixture({ storedRaw: "original native credential" })
  const authorized = await f.method.authorize(loginConfig)
  f.credential = "new credential written by Antigravity"
  const result = await authorized.callback()
  assert.equal(result.type, "failed")
  assert.match(result.error, /changed/i)
  assert.equal(f.credential, "new credential written by Antigravity")
  assert.equal(f.installs.length, 1)
  assert.equal(f.profiles.length, 0)
  assert.equal(f.flow.closed, 1)
})

test("fresh login rejects a native account switch after installation before verification", async () => {
  const encode = (profile) => "go-keyring-base64:" + Buffer.from(JSON.stringify(profile)).toString("base64")
  const accountB = encode({
    token: { access_token: "account-b-access", refresh_token: "account-b-refresh", token_type: "Bearer", expiry: new Date(Date.now() + 3_600_000).toISOString() },
    auth_method: "gcp", wif_provider: "", project_id: loginConfig.projectId, region: loginConfig.location, user_tier: "account-b-tier",
  })
  let credential = "old native credential"
  let installed
  let sessionCount = 0
  let oldProfileCalls = 0
  const principals = new Map()
  const nativeRequests = []
  const requests = []
  const oldSession = {
    async profile() { oldProfileCalls++; return { token: { access_token: "old-access" } } },
    binding: () => "previous-binding",
    identity: async () => "antigravity/previous-session",
  }
  const nativeDeps = {
    readCredential: async () => credential,
    readPrincipal: async (key) => principals.get(key),
    writePrincipal: async (key, principal) => { principals.set(key, principal) },
    metadata: async () => ({ version: "1.5.5", cl: "1017970541", platform: "darwin", arch: "arm64" }),
    fetch: async (url, init) => {
      nativeRequests.push({ url, headers: new Headers(init.headers) })
      return json({ id: "account-b" })
    },
  }
  const plugin = await AntigravityEnterprisePlugin({}, { _deps: {
    createNativeSession: () => sessionCount++ === 0 ? oldSession : createNativeSession({ _deps: nativeDeps }),
    readLoginCredential: async () => credential,
    installLoginCredential: async (_stateDir, expected, replacement) => {
      assert.equal(expected, credential)
      installed = replacement
      credential = replacement
      credential = accountB
      return true
    },
    startEnterpriseLogin: async () => ({ url: "https://accounts.example.test/enterprise", wait: async () => ({ ...loginToken }), close() {} }),
    fetch: async (url, init) => {
      requests.push({ url, headers: new Headers(init.headers) })
      return url.endsWith(":fetchLicenses") ? json({ licenses: [loginLicense] }) : json({ models: { old: { displayName: "Old model" } } })
    },
  } })
  const oldMetadata = { ...loginConfig, wifProvider: "", nativeBinding: "previous-binding", userTier: "previous-tier" }
  const method = plugin.auth.methods.find((item) => item.type === "oauth")
  const previousModels = await plugin.provider.models({}, { auth: { type: "api", metadata: oldMetadata } })
  assert.deepEqual(Object.keys(previousModels), ["old"])
  const result = await (await method.authorize(loginConfig)).callback()
  assert.equal(result.type, "failed")
  assert.match(result.error, /changed/i)
  assert.equal(Object.hasOwn(result, "metadata"), false)
  assert.equal(Object.hasOwn(result, "key"), false)
  assert.equal(credential, accountB)
  const installedProfile = JSON.parse(Buffer.from(installed.slice("go-keyring-base64:".length), "base64").toString())
  assert.equal(installedProfile.token.access_token, loginToken.access_token)
  assert.equal(installedProfile.user_tier, loginLicense.userTier)
  assert.deepEqual(nativeRequests, [])
  assert.equal(principals.size, 0)
  assert.equal(requests.length, 2)
  assert.equal(requests[1].headers.get("authorization"), `Bearer ${loginToken.access_token}`)

  const models = await plugin.provider.models({}, { auth: { type: "api", metadata: oldMetadata } })
  assert.deepEqual(Object.keys(models), ["old"])
  assert.equal(oldProfileCalls, 2)
  assert.equal(requests[2].headers.get("authorization"), "Bearer old-access")
  assert.equal(requests.some(({ headers }) => headers.get("authorization") === "Bearer account-b-access"), false)
})

test("a long-lived provider follows an independently signed-in native account without rebinding the previous account", async () => {
  const encode = (profile) => "go-keyring-base64:" + Buffer.from(JSON.stringify(profile)).toString("base64")
  const profileFor = (account) => ({
    token: { access_token: `${account}-access`, refresh_token: `${account}-refresh`, token_type: "Bearer", expiry: new Date(Date.now() + 3_600_000).toISOString() },
    auth_method: "gcp", wif_provider: "", project_id: "licensed-project", region: "eu", user_tier: `${account}-tier`,
  })
  let credential = encode(profileFor("account-a"))
  const principals = new Map()
  const requests = []
  const deps = {
    readCredential: async ({ interactive }) => {
      assert.notEqual(interactive, true, "Saved-account requests must not prompt for Keychain authorization")
      return credential
    },
    readPrincipal: async (key) => principals.get(key),
    writePrincipal: async (key, principal) => { principals.set(key, principal) },
    metadata: async () => ({ version: "1.5.5", cl: "1017970541", platform: "darwin", arch: "arm64" }),
    async fetch(url, init) {
      const headers = new Headers(init.headers)
      const authorization = headers.get("authorization")
      assert.ok(["Bearer account-a-access", "Bearer account-b-access"].includes(authorization))
      if (url === "https://www.googleapis.com/oauth2/v2/userinfo") return json({ id: authorization === "Bearer account-a-access" ? "account-a" : "account-b" })
      requests.push({ url, headers, payload: JSON.parse(init.body) })
      if (url.endsWith(":retrieveUserQuotaSummary")) return json(quotaSummary)
      if (url.endsWith(":fetchAvailableModels")) return json({ models: { "account-b-model": { displayName: "Account B model" } } })
      assert.match(url, /:streamGenerateContent/)
      return sse()
    },
  }
  const options = { _deps: deps }
  const metadataForCurrentAccount = async (tier) => {
    const independentSession = createNativeSession(options)
    const profile = await independentSession.profile()
    return { type: "api", metadata: { ...loginConfig, wifProvider: "", nativeBinding: independentSession.binding(profile), userTier: tier } }
  }
  const authA = await metadataForCurrentAccount("account-a-tier")
  let currentAuth = authA
  const plugin = await AntigravityEnterprisePlugin({}, options)
  const client = await plugin.auth.loader(async () => currentAuth)
  await assertAnswer(await client.fetch(endpoint, { method: "POST", body: JSON.stringify(inputBody) }))
  assert.equal(requests[0].headers.get("authorization"), "Bearer account-a-access")

  credential = encode(profileFor("account-b"))
  const authB = await metadataForCurrentAccount("account-b-tier")
  assert.notEqual(authB.metadata.nativeBinding, authA.metadata.nativeBinding)
  currentAuth = authB
  const usage = await plugin.auth.usage(async () => currentAuth, quotaProvider)
  assert.equal(usage.error, undefined)
  assert.ok(usage.windows.length > 0)
  const models = await plugin.provider.models({}, { auth: authB })
  assert.deepEqual(Object.keys(models), ["account-b-model"])
  await assertAnswer(await client.fetch(endpoint, { method: "POST", body: JSON.stringify(inputBody) }))
  assert.equal(requests.length, 4)
  assert.ok(requests.slice(1).every(({ headers }) => headers.get("authorization") === "Bearer account-b-access"))
  assert.equal(requests[2].payload.entitlement.userTier, "account-b-tier")
  assert.equal(requests[3].payload.entitlement.userTier, "account-b-tier")

  const previousUsage = await plugin.auth.usage(async () => authA, quotaProvider)
  assert.equal(previousUsage.signIn, "expired")
  assert.match(previousUsage.error, /changed/i)
  await assert.rejects(plugin.provider.models({}, { auth: authA }), (error) => error.code === "ERR_NATIVE_ACCOUNT_CHANGED")
  currentAuth = authA
  const previousGeneration = await client.fetch(endpoint, { method: "POST", body: JSON.stringify(inputBody) })
  assert.equal(previousGeneration.status, 401)
  assert.equal(previousGeneration.headers.get("X-Magpie-Sign-In"), "expired")
  assert.equal(requests.length, 4, "An obsolete saved account must fail before any enterprise request")
})

test("browser sign-in validates explicit configuration before touching native credentials or starting OAuth", async () => {
  const f = await browserSignInFixture()
  for (const config of [
    { ...loginConfig, authMethod: "auto" },
    { ...loginConfig, authMethod: undefined },
    { ...loginConfig, authMethod: "wif", wifProvider: " " },
    { ...loginConfig, projectId: "" },
    { ...loginConfig, location: "us-central1" },
  ]) {
    const result = await f.method.authorize(config)
    assert.equal(result.type, "failed")
  }
  assert.equal(f.reads.length, 0)
  assert.equal(f.starts.length, 0)
  assert.equal(f.profiles.length, 0)
})

test("denied Keychain snapshot access requires authorization instead of being treated as an empty native account", async () => {
  const f = await browserSignInFixture()
  const denied = Object.assign(new KeychainError("denied"), { cause: new Error("private cause"), stdout: "private output" })
  f.deps.readLoginCredential = async () => { throw denied }
  const plugin = await AntigravityEnterprisePlugin({}, { _deps: f.deps })
  const result = await plugin.auth.methods.find((method) => method.type === "oauth").authorize(loginConfig)
  assert.equal(result.type, "failed")
  assert.match(result.error, /macOS denied access.*Keychain/)
  assert.match(result.error, /authorize/)
  assert.equal(f.starts.length, 0)
  assert.equal(f.installs.length, 0)
  assert.equal(JSON.stringify(result).includes("private"), false)
})

test("fresh WIF profile uses only the chosen provider and does not invent a native tier display label", async () => {
  const f = await browserSignInFixture({ responses: [json({ licenses: [{ ...loginLicense, tierDisplayName: undefined }] })] })
  const config = { ...loginConfig, authMethod: "wif", wifProvider: " locations/global/workforcePools/enterprise/providers/sso " }
  const result = await (await f.method.authorize(config)).callback()
  assert.equal(result.type, "success")
  assert.equal(f.installs[0].expected, null)
  const installed = JSON.parse(Buffer.from(f.installs[0].replacement.slice("go-keyring-base64:".length), "base64").toString())
  assert.equal(installed.auth_method, "wif")
  assert.equal(installed.wif_provider, "locations/global/workforcePools/enterprise/providers/sso")
  assert.equal(Object.hasOwn(installed, "tier_display_name"), false)
  assert.equal(result.metadata.tierDisplayName, "enterprise-tier")
})

test("browser interaction outlives the native snapshot deadline and each later resource gets a fresh deadline", async (t) => {
  const deadlines = []
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    const controller = new AbortController()
    deadlines.push({ milliseconds, controller })
    return controller.signal
  })
  const f = await browserSignInFixture()
  const waiting = deferred(), token = deferred()
  f.flow.wait = ({ signal } = {}) => {
    assert.equal(signal, undefined, "A 30-second resource deadline must not limit browser interaction")
    waiting.resolve()
    return token.promise
  }
  const authorized = await f.method.authorize(loginConfig)
  const callback = authorized.callback()
  await waiting.promise
  assert.equal(deadlines.length, 1)
  deadlines[0].controller.abort(new DOMException("Native read deadline elapsed", "TimeoutError"))
  assert.equal(f.flow.closed, 0)
  token.resolve(loginToken)
  const result = await callback
  assert.equal(result.type, "success")
  assert.deepEqual(deadlines.map(({ milliseconds }) => milliseconds), [30_000, 30_000, 30_000, 30_000])
  assert.notEqual(f.requests[0].signal, f.reads[0].signal)
  assert.notEqual(f.installs[0].signal, f.requests[0].signal)
  assert.notEqual(f.profiles[0].signal, f.installs[0].signal)
  assert.equal(f.flow.closed, 1)
})

test("cancelling callback browser interaction closes the flow and late tokens cannot install a native account", { timeout: 5000 }, async () => {
  const f = await browserSignInFixture()
  const waiting = deferred(), token = deferred()
  const controller = new AbortController()
  f.flow.wait = () => { waiting.resolve(); return token.promise }
  const authorized = await f.method.authorize(loginConfig)
  const callback = authorized.callback(undefined, { signal: controller.signal })
  await waiting.promise
  const reason = new Error("The user cancelled enterprise sign-in")
  controller.abort(reason)
  await assert.rejects(callback, (error) => error === reason)
  token.resolve(loginToken)
  await token.promise
  await Promise.resolve()
  assert.equal(f.flow.closed, 1)
  assert.equal(f.installs.length, 0)
  assert.equal(f.requests.length, 0)
  assert.equal(f.profiles.length, 0)
})

test("cancelling after license approval prevents native installation and closes the browser flow", async () => {
  const controller = new AbortController()
  const reason = new Error("Cancelled just before native install")
  const f = await browserSignInFixture({ storedRaw: "old credential", responses: [() => {
    controller.abort(reason)
    return json({ licenses: [loginLicense] })
  }] })
  const authorized = await f.method.authorize(loginConfig)
  await assert.rejects(authorized.callback(undefined, { signal: controller.signal }), (error) => error === reason)
  assert.equal(f.installs.length, 0)
  assert.equal(f.credential, "old credential")
  assert.equal(f.flow.closed, 1)
})

test("authorization cancellation closes a flow even if Magpie never calls its callback", async () => {
  const f = await browserSignInFixture()
  const controller = new AbortController()
  const authorized = await f.method.authorize(loginConfig, { signal: controller.signal })
  controller.abort(new Error("Cancelled enterprise sign-in dialog"))
  await Promise.resolve()
  assert.equal(f.flow.closed, 1)
  await assert.rejects(authorized.callback(), /Cancelled enterprise sign-in dialog/)
  assert.equal(f.flow.closed, 1)
  assert.equal(f.installs.length, 0)
})

test("expired and failed browser callbacks close their flow without exposing code, token, subprocess output, or causes", async () => {
  for (const failure of [
    new EnterpriseLoginError("ERR_LOGIN_TIMEOUT", "Enterprise sign-in expired. Start sign-in again."),
    Object.assign(new Error("private auth-code verifier access-token"), { cause: new Error("private secret cause"), stdout: "private subprocess output" }),
  ]) {
    const f = await browserSignInFixture()
    f.flow.wait = async () => { throw failure }
    const result = await (await f.method.authorize(loginConfig)).callback()
    assert.equal(result.type, "failed")
    assert.equal(JSON.stringify(result).includes("private"), false)
    assert.equal(f.flow.closed, 1)
    assert.equal(f.installs.length, 0)
    assert.equal(f.requests.length, 0)
  }
})

test("malformed OAuth token fields never reach licensing or native credentials", async () => {
  for (const token of [
    { ...loginToken, access_token: "" }, { ...loginToken, refresh_token: "" },
    { ...loginToken, expires_in: 0 }, { ...loginToken, expires_in: Infinity }, { ...loginToken, expires_in: Number.MAX_VALUE },
  ]) {
    const f = await browserSignInFixture()
    f.flow.wait = async () => token
    const result = await (await f.method.authorize(loginConfig)).callback()
    assert.equal(result.type, "failed")
    assert.equal(f.requests.length, 0)
    assert.equal(f.installs.length, 0)
    assert.equal(f.profiles.length, 0)
    assert.equal(f.flow.closed, 1)
  }
})

test("cancelling quota while discarding its first 401 body prevents renewal and replay", async (t) => {
  const discarding = deferred()
  const pendingDiscard = deferred()
  const rejected = new Response(new ReadableStream({
    cancel() { discarding.resolve(); return pendingDiscard.promise },
  }), { status: 401 })
  const f = await fixture(t, [rejected])
  const controller = new AbortController()
  const result = f.plugin.auth.usage(async () => ({ type: "api", metadata: f.metadata }), quotaProvider, { signal: controller.signal })
  await discarding.promise
  assert.equal(f.profiles.length, 1)
  const reason = new Error("Cancelled while discarding rejected quota response")
  controller.abort(reason)
  await assert.rejects(result, (error) => error === reason)
  pendingDiscard.resolve()
  await pendingDiscard.promise
  await Promise.resolve()
  assert.equal(f.profiles.length, 1)
  assert.equal(f.requests.length, 1)
})

test("generation preserves sign-in when Keychain access is denied during lookup or renewal", async (t) => {
  for (const deniedAt of ["lookup", "renewal"]) {
    const rejected = json({}, 401)
    const f = await fixture(t, deniedAt === "renewal" ? [rejected] : [])
    const profile = f.native.profile
    f.native.profile = (options) => {
      if ((options.forceRefresh ? "renewal" : "lookup") === deniedAt) {
        throw Object.assign(new Error("Keychain access was denied"), { signIn: "kept" })
      }
      return profile(options)
    }
    const response = await f.fetch(endpoint, { method: "POST", body: JSON.stringify(inputBody) })
    assert.equal(response.status, 502)
    assert.equal(response.headers.get("x-magpie-sign-in"), "kept")
    assert.match((await response.json()).error.message, /Keychain access was denied/)
    assert.equal(f.requests.length, deniedAt === "renewal" ? 1 : 0)
    if (deniedAt === "renewal") assert.equal(rejected.bodyUsed, true)
  }
})
