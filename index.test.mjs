import test from "node:test"
import assert from "node:assert/strict"
import { AntigravityEnterprisePlugin } from "./index.mjs"

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

test("quota read 401 expires auth while 403 preserves it without refreshing or fake usage", async (t) => {
  for (const status of [401, 403]) {
    const f = await fixture(t, [json({ error: { message: "Sign in again to access this quota resource" } }, status)])
    const result = await f.plugin.auth.usage(async () => ({ type: "api", metadata: f.metadata }), quotaProvider)
    assert.equal(result.signIn, status === 401 ? "expired" : "kept")
    assert.match(result.error, new RegExp(`HTTP ${status}`))
    assert.equal(Object.hasOwn(result, "windows"), false)
    assert.equal(f.requests.length, 1)
    assert.deepEqual(f.profiles.map((options) => options.forceRefresh), [false])
  }
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
