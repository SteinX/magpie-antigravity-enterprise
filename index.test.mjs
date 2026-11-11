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

async function fixture(t, responses = [sse()], { binding = "native-account" } = {}) {
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
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, ...init, headers: new Headers(init.headers), payload: JSON.parse(init.body) })
    const response = responses[requests.length - 1]
    assert.ok(response, "An unexpected upstream request was made")
    return response
  })
  const plugin = await AntigravityEnterprisePlugin({}, { _deps: { createNativeSession: () => native } })
  const client = await plugin.auth.loader(async () => ({ type: "api", metadata }))
  return { fetch: client.fetch, requests, profiles, metadata }
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
    headers: { "content-type": "application/json", "x-aicode-trajectory-id": "request-session" },
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
  assert.equal(sent.headers.get("accept"), "text/event-stream")
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
  const f = await fixture(t, [rejected, sse()])
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
