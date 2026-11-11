import test from "node:test"
import assert from "node:assert/strict"
import { PROVIDER, BASE, validateTarget, enterpriseURL, buildPayload, catalogModels, adaptResponse } from "./protocol.mjs"

const encoder = new TextEncoder()
const target = { projectId: "enterprise-project", location: "global" }

function sseResponse(text, fragments = [1, 2, 5, 3, 8]) {
  const bytes = encoder.encode(text)
  let offset = 0
  let fragment = 0
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close()
      const end = Math.min(offset + fragments[fragment++ % fragments.length], bytes.length)
      controller.enqueue(bytes.slice(offset, end))
      offset = end
    },
  }), { headers: { "content-type": "text/event-stream; charset=utf-8", "x-request-id": "request-42" } })
}

const event = (value, ending = "\n\n") => `data: ${JSON.stringify(value)}${ending}`

for (const [location, host] of [
  ["global", "businessaicode.googleapis.com"],
  ["us", "businessaicode.us.rep.googleapis.com"],
  ["eu", "businessaicode.eu.rep.googleapis.com"],
]) {
  test(`routes ${location} inference to the documented regional host`, () => {
    assert.equal(enterpriseURL({ ...target, location }), `https://${host}/v1beta/projects/enterprise-project/locations/${location}:streamGenerateContent?alt=sse`)
    assert.equal(enterpriseURL({ ...target, location }, "generateContent", false), `https://${host}/v1beta/projects/enterprise-project/locations/${location}:generateContent`)
  })
}

test("requires explicit account target and rejects unsupported locations", () => {
  assert.deepEqual(validateTarget({ projectId: "  enterprise-project  ", location: " EU " }), { projectId: "enterprise-project", location: "eu" })
  assert.deepEqual(validateTarget({ projectId: "123456789", location: "global" }), { projectId: "123456789", location: "global" })
  for (const location of [undefined, null, "", "us-central1", "europe-west1", "europe", "eu/path", "global?alt=json", 1]) {
    assert.throws(() => validateTarget({ ...target, location }), /location|global, us, or eu/)
  }
  for (const invalid of [undefined, {}, { location: "global" }, { ...target, projectId: "projects/enterprise-project" }, { ...target, projectId: "x?alt=json" }]) {
    assert.throws(() => validateTarget(invalid), /projectId/)
  }
  assert.throws(() => enterpriseURL(target, "generateContent?key=unexpected"), /action/)
})

test("builds a flat native request with authoritative selected model and tier", () => {
  const contents = [{ role: "user", parts: [{ text: "hello" }] }]
  const body = {
    contents,
    systemInstruction: { parts: [{ text: "Camel instruction" }] },
    system_instruction: { parts: [{ text: "Other instruction" }] },
    generationConfig: { maxOutputTokens: 321, temperature: 0.4, thinkingConfig: { thinkingBudget: 64 } },
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    labels: { purpose: "test" },
    tools: [],
    aicode: { experience: "caller-model", extra: "not accepted" },
    entitlement: { userTier: "caller-tier", extra: "not accepted" },
    model: "caller-model",
    project: "caller-project",
    request: { contents: [] },
    safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" }],
    unknownField: true,
  }
  const payload = buildPayload(body, "gemini-3.8-flash-low", "enterprise-seat-tier")
  assert.deepEqual(Object.keys(payload).sort(), ["aicode", "contents", "entitlement", "generationConfig", "labels", "systemInstruction", "toolConfig", "tools"])
  assert.deepEqual(payload.aicode, { experience: "gemini-3.8-flash-low" })
  assert.deepEqual(payload.entitlement, { userTier: "enterprise-seat-tier" })
  assert.deepEqual(payload.systemInstruction, body.systemInstruction)
  assert.deepEqual(payload.generationConfig, body.generationConfig)
  assert.deepEqual(payload.contents, contents)
  assert.deepEqual(buildPayload({ system_instruction: body.system_instruction }, "m", "t").systemInstruction, body.system_instruction)
})

test("normalizes schema spelling and gives parametersJsonSchema precedence without mutating input", () => {
  const jsonSchema = { type: "object", properties: { path: { type: "string", description: "File path" } }, required: ["path"] }
  const body = {
    tools: [{ functionDeclarations: [
      { name: "read_file", description: "Read", parameters: { type: "string" }, parametersJsonSchema: jsonSchema },
      { name: "already_native", parameters: { type: "object", properties: {} } },
    ] }, { googleSearch: {} }],
  }
  const before = structuredClone(body)
  const payload = buildPayload(body, "model", "tier")
  assert.deepEqual(payload.tools[0].functionDeclarations[0], { name: "read_file", description: "Read", parameters: jsonSchema })
  assert.deepEqual(payload.tools[0].functionDeclarations[1], body.tools[0].functionDeclarations[1])
  assert.deepEqual(payload.tools[1], { googleSearch: {} })
  assert.deepEqual(body, before)
})

test("replays real signatures and tool IDs exactly and leaves unsigned calls unsigned", () => {
  const contents = [
    { role: "model", parts: [
      { thoughtSignature: "cmVhbC1zaWduYXR1cmU=", functionCall: { id: "call:1/真实", name: "lookup", args: { value: 1 } } },
      { functionCall: { id: "call:2", name: "lookup", args: { value: 2 } } },
    ] },
    { role: "user", parts: [{ functionResponse: { id: "call:1/真实", name: "lookup", response: { result: 3 } } }] },
  ]
  const payload = buildPayload({ contents }, "model", "tier")
  assert.deepEqual(payload.contents, contents)
  assert.equal(Object.hasOwn(payload.contents[0].parts[1], "thoughtSignature"), false)
})

test("catalog keeps every enabled exact API ID and uses upstream limits and media capabilities", () => {
  const catalog = {
    models: {
      "gemini-3.8-flash-low": {
        displayName: "Gemini 3.8 Flash (Low)", model: "MODEL_PLACEHOLDER_M320", apiProvider: "API_PROVIDER_GOOGLE_VERTEX",
        supportsThinking: true, supportsImages: true, supportsVideo: true,
        minThinkingBudget: 32, thinkingBudget: 1000, maxTokens: 1048576, maxOutputTokens: 65536,
        supportedMimeTypes: { "image/png": true, "audio/ogg": true, "video/mp4": true, "application/pdf": true, "audio/disabled": false },
      },
      "not-in-picker": { displayName: "Also Enabled", supportsThinking: false, maxTokens: 8192, maxOutputTokens: 1024 },
      "chat_enabled": { displayName: "Enabled Upstream ID", maxTokens: 4096, maxOutputTokens: 512 },
      "disabled-model": { disabled: true, displayName: "Disabled" },
    },
    agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.8-flash-low"] }] }],
  }
  const models = catalogModels(catalog)
  assert.deepEqual(Object.keys(models), ["gemini-3.8-flash-low", "not-in-picker", "chat_enabled"])
  const model = models["gemini-3.8-flash-low"]
  assert.equal(model.id, "gemini-3.8-flash-low")
  assert.equal(model.providerID, PROVIDER)
  assert.deepEqual(model.api, { id: "gemini-3.8-flash-low", url: BASE, npm: "@ai-sdk/google" })
  assert.deepEqual(model.limit, { context: 1048576, output: 65536 })
  assert.equal(model.capabilities.reasoning, true)
  assert.equal(model.capabilities.attachment, true)
  assert.deepEqual(model.capabilities.input, { text: true, image: true, audio: true, video: true, pdf: true })
  assert.equal(models["not-in-picker"].capabilities.reasoning, false)
  assert.equal(models["not-in-picker"].capabilities.attachment, false)
  assert.deepEqual(catalogModels({ models: {} }), {})
})

test("preserves HTTP error responses including status, headers, and body", async () => {
  for (const wantsStream of [false, true]) {
    const upstream = new Response('{"error":{"message":"license required"}}', { status: 403, statusText: "Forbidden", headers: { "content-type": "application/json", "retry-after": "17" } })
    const result = adaptResponse(upstream, wantsStream)
    assert.equal(result, upstream)
    assert.equal(result.status, 403)
    assert.equal(result.statusText, "Forbidden")
    assert.equal(result.headers.get("retry-after"), "17")
    assert.equal(await result.text(), '{"error":{"message":"license required"}}')
  }
})

test("passes direct SSE through without consuming or rewriting it", async () => {
  const raw = event({ candidates: [{ content: { parts: [{ text: "unchanged" }] } }] })
  const upstream = sseResponse(raw)
  const result = adaptResponse(upstream, true)
  assert.equal(result, upstream)
  assert.equal(result.bodyUsed, false)
  assert.equal(result.body.locked, false)
  assert.equal(await result.text(), raw)
})

test("leaves native JSON success responses intact", async () => {
  const upstream = new Response('{"candidates":[]}', { headers: { "content-type": "application/json" } })
  assert.equal(adaptResponse(upstream, false), upstream)
  assert.equal(await upstream.text(), '{"candidates":[]}')
})

test("aggregates fragmented SSE preserving parallel tool calls, real signatures, and final metadata", async () => {
  const signedCall = { functionCall: { id: "lookup:1/真实", name: "lookup", args: { place: "東京" } }, thoughtSignature: "c2lnbmVkLXRvb2wtY2FsbA==" }
  const unsignedCall = { functionCall: { id: "lookup:2", name: "lookup", args: { place: "Paris" } } }
  const signedText = { text: "Signed explanation", thoughtSignature: "c2lnbmVkLXRleHQ=" }
  const chunks = [
    { responseId: "response-1", modelVersion: "upstream-version", candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Thinking", thought: true }] } }] },
    { candidates: [{ index: 0, content: { parts: [{ text: " carefully", thought: true }, signedCall] } }], usageMetadata: { promptTokenCount: 100 } },
    { candidates: [{ index: 0, content: { parts: [unsignedCall, signedText, { text: " more text" }] } }] },
    { candidates: [{ index: 0, finishReason: "STOP", finishMessage: "Finished", safetyRatings: [{ category: "HARM_CATEGORY_HARASSMENT", probability: "NEGLIGIBLE" }] }], usageMetadata: { candidatesTokenCount: 20, totalTokenCount: 120 } },
  ]
  const result = adaptResponse(sseResponse(": heartbeat\r\n\r\n" + chunks.map((chunk) => event(chunk, "\r\n\r\n")).join("") + "data: [DONE]\r\n\r\n", [1]), false)
  assert.equal(result.headers.get("content-type"), "application/json")
  assert.equal(result.headers.get("x-request-id"), "request-42")
  const output = await result.json()
  assert.equal(output.responseId, "response-1")
  assert.equal(output.modelVersion, "upstream-version")
  assert.deepEqual(output.usageMetadata, { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 })
  assert.deepEqual(output.candidates[0].content, { role: "model", parts: [
    { text: "Thinking carefully", thought: true }, signedCall, unsignedCall, signedText, { text: " more text" },
  ] })
  assert.equal(output.candidates[0].finishReason, "STOP")
  assert.equal(output.candidates[0].finishMessage, "Finished")
  assert.deepEqual(output.candidates[0].safetyRatings, chunks[3].candidates[0].safetyRatings)
})

test("collects candidates by index and supports multiline events and an unterminated final event", async () => {
  const first = { candidates: [
    { index: 1, content: { role: "model", parts: [{ text: "second" }] } },
    { index: 0, content: { role: "model", parts: [{ text: "first" }] } },
  ] }
  const second = { candidates: [
    { index: 0, content: { parts: [{ text: " choice" }] }, finishReason: "MAX_TOKENS" },
    { index: 1, finishReason: "STOP" },
  ], promptFeedback: { safetyRatings: [] } }
  const multiline = JSON.stringify(first, null, 2).split("\n").map((line) => `data: ${line}`).join("\n") + "\n\n"
  const output = await adaptResponse(sseResponse(multiline + event(second, "")), false).json()
  assert.deepEqual(output.candidates.map((candidate) => candidate.index), [0, 1])
  assert.deepEqual(output.candidates.map((candidate) => candidate.content.parts), [[{ text: "first choice" }], [{ text: "second" }]])
  assert.deepEqual(output.candidates.map((candidate) => candidate.finishReason), ["MAX_TOKENS", "STOP"])
  assert.deepEqual(output.promptFeedback, { safetyRatings: [] })
})

test("retains blocked prompt feedback without inventing a model completion", async () => {
  const promptFeedback = { blockReason: "SAFETY", blockReasonMessage: "Blocked upstream" }
  const output = await adaptResponse(sseResponse(event({ promptFeedback, usageMetadata: { promptTokenCount: 9 } })), false).json()
  assert.deepEqual(output, { candidates: [], promptFeedback, usageMetadata: { promptTokenCount: 9 } })
})

test("cancels the upstream body when the JSON consumer cancels during aggregation", async () => {
  let signalPull
  const pulled = new Promise((resolve) => { signalPull = resolve })
  let cancellationReason
  const upstream = new Response(new ReadableStream({
    pull() { signalPull() },
    cancel(reason) { cancellationReason = reason },
  }), { headers: { "content-type": "text/event-stream" } })
  const reader = adaptResponse(upstream, false).body.getReader()
  const pendingRead = reader.read()
  await pulled
  const reason = new Error("Consumer stopped")
  await reader.cancel(reason)
  assert.equal(cancellationReason, reason)
  assert.deepEqual(await pendingRead, { value: undefined, done: true })
})

test("preserves streaming cancellation through the original body", async () => {
  let cancellationReason
  const upstream = new Response(new ReadableStream({
    cancel(reason) { cancellationReason = reason },
  }), { headers: { "content-type": "text/event-stream" } })
  const reason = new Error("Stream reader stopped")
  await adaptResponse(upstream, true).body.cancel(reason)
  assert.equal(cancellationReason, reason)
})

test("propagates an upstream abort while aggregating instead of returning partial JSON", async () => {
  const abort = new AbortController()
  let signalPull
  const pulled = new Promise((resolve) => { signalPull = resolve })
  const upstream = new Response(new ReadableStream({
    start(controller) { abort.signal.addEventListener("abort", () => controller.error(abort.signal.reason), { once: true }) },
    pull() { signalPull() },
  }), { headers: { "content-type": "text/event-stream" } })
  const output = adaptResponse(upstream, false)
  const reading = output.text()
  await pulled
  const reason = new DOMException("Request aborted", "AbortError")
  abort.abort(reason)
  await assert.rejects(reading, (error) => error === reason)
})

test("does not hide malformed upstream events as a successful empty response", async () => {
  const output = adaptResponse(sseResponse('data: {"candidates":broken}\n\n'), false)
  await assert.rejects(output.json(), SyntaxError)
})
