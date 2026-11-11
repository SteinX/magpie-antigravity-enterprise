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

test("preserves explicit JSON Schema and prefers it over a conflicting native schema without mutating input", () => {
  const jsonSchema = { type: "object", properties: { path: { type: "string", description: "File path" } }, required: ["path"] }
  const body = {
    tools: [{ functionDeclarations: [
      { name: "read_file", description: "Read", parameters: { type: "STRING" }, parametersJsonSchema: jsonSchema },
      { name: "json_only", parametersJsonSchema: jsonSchema },
    ] }, { googleSearch: {} }],
  }
  const before = structuredClone(body)
  const payload = buildPayload(body, "model", "tier")
  for (const declaration of payload.tools[0].functionDeclarations) {
    assert.equal(Object.hasOwn(declaration, "parameters"), false)
    assert.deepEqual(declaration.parametersJsonSchema.properties.path, { type: "string", description: "File path" })
    assert.deepEqual(declaration.parametersJsonSchema.required, ["path"])
  }
  assert.equal(payload.tools[0].functionDeclarations[0].name, "read_file")
  assert.equal(payload.tools[0].functionDeclarations[0].description, "Read")
  assert.deepEqual(payload.tools[1], { googleSearch: {} })
  assert.deepEqual(body, before)
})

test("keeps native Google Schema types, nullable, enum, and property ordering in parameters", () => {
  const parameters = {
    type: "OBJECT",
    properties: {
      mode: { type: "STRING", format: "enum", enum: ["FAST", "EXACT"], nullable: true },
      items: { type: "ARRAY", items: { anyOf: [{ type: "STRING" }, { type: "INTEGER" }] } },
      $ref: { type: "STRING", default: "A property name is not a schema keyword" },
      metadata: { type: "OBJECT", default: { $defs: { preserved: true }, type: ["arbitrary", "data"] }, example: { additionalProperties: false } },
    },
    required: ["mode"],
    propertyOrdering: ["mode", "items", "$ref", "metadata"],
  }
  const output = buildPayload({ tools: [{ functionDeclarations: [{ name: "native", parameters }] }] }, "model", "tier").tools[0].functionDeclarations[0]
  assert.equal(Object.hasOwn(output, "parametersJsonSchema"), false)
  assert.equal(output.parameters.type, "OBJECT")
  assert.deepEqual(output.parameters.properties.mode, { type: "STRING", format: "enum", enum: ["FAST", "EXACT"], nullable: true })
  assert.deepEqual(output.parameters.properties.items.items.anyOf, [{ type: "STRING" }, { type: "INTEGER" }])
  assert.deepEqual(output.parameters.propertyOrdering, ["mode", "items", "$ref", "metadata"])
  assert.deepEqual(output.parameters.properties.metadata.default, { $defs: { preserved: true }, type: ["arbitrary", "data"] })
})

test("routes JSON Schema constructs nested in legacy parameters without deleting their semantics", () => {
  const cases = [
    { type: "object", properties: { value: { type: ["string", "null"] } } },
    { type: "object", properties: { values: { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } } } },
    { type: "object", properties: { value: { anyOf: [{ type: "string" }, { const: 42 }] } } },
    { type: "object", properties: { value: { enum: [1, 2, null] } } },
    { type: "object", additionalProperties: false },
    { type: "object", properties: { forbidden: false } },
  ]
  for (const parameters of cases) {
    const before = structuredClone(parameters)
    const declaration = buildPayload({ tools: [{ functionDeclarations: [{ name: "json", parameters }] }] }, "model", "tier").tools[0].functionDeclarations[0]
    assert.equal(Object.hasOwn(declaration, "parameters"), false)
    assert.deepEqual(declaration.parametersJsonSchema, before)
    assert.deepEqual(parameters, before)
  }
})

// The parent probe sent this same schema to the enterprise endpoint: parameters
// returned HTTP 400; parametersJsonSchema returned HTTP 200 without rewriting it.
test("preserves the enterprise-probed complex schema in the JSON Schema parameter field", () => {
  const schema = {
    type: "object",
    $defs: { Item: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
    properties: {
      item: { $ref: "#/$defs/Item" },
      choice: { anyOf: [{ type: "string" }, { type: "integer" }] },
      optional: { type: ["string", "null"] },
      options: { type: "object", additionalProperties: { type: "string" } },
    },
    required: ["item"],
    additionalProperties: false,
  }
  const before = structuredClone(schema)
  const tools = [{ functionDeclarations: [
    { name: "legacy_schema", parameters: schema },
    { name: "explicit_json_schema", parametersJsonSchema: schema },
  ] }]
  const declarations = buildPayload({ tools }, "model", "tier").tools[0].functionDeclarations
  for (const declaration of declarations) {
    assert.equal(Object.hasOwn(declaration, "parameters"), false)
    const output = declaration.parametersJsonSchema
    assert.equal(output.type, "object")
    assert.equal(output.properties.item.$ref, "#/$defs/Item")
    assert.deepEqual(output.$defs.Item, { type: "object", properties: { name: { type: "string" } }, required: ["name"] })
    assert.deepEqual(output.properties.choice.anyOf, [{ type: "string" }, { type: "integer" }])
    assert.deepEqual(output.properties.optional.type, ["string", "null"])
    assert.deepEqual(output.properties.options.additionalProperties, { type: "string" })
    assert.equal(output.additionalProperties, false)
    assert.deepEqual(output.required, ["item"])
  }
  assert.deepEqual(schema, before)
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
    const result = await adaptResponse(upstream, wantsStream)
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
  const result = await adaptResponse(upstream, true)
  assert.equal(result, upstream)
  assert.equal(result.bodyUsed, false)
  assert.equal(result.body.locked, false)
  assert.equal(await result.text(), raw)
})

test("leaves native JSON success responses intact", async () => {
  const upstream = new Response('{"candidates":[]}', { headers: { "content-type": "application/json" } })
  assert.equal(await adaptResponse(upstream, false), upstream)
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
  const result = await adaptResponse(sseResponse(": heartbeat\r\n\r\n" + chunks.map((chunk) => event(chunk, "\r\n\r\n")).join("") + "data: [DONE]\r\n\r\n", [1]), false)
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
  const output = await (await adaptResponse(sseResponse(multiline + event(second, "")), false)).json()
  assert.deepEqual(output.candidates.map((candidate) => candidate.index), [0, 1])
  assert.deepEqual(output.candidates.map((candidate) => candidate.content.parts), [[{ text: "first choice" }], [{ text: "second" }]])
  assert.deepEqual(output.candidates.map((candidate) => candidate.finishReason), ["MAX_TOKENS", "STOP"])
  assert.deepEqual(output.promptFeedback, { safetyRatings: [] })
})

test("retains blocked prompt feedback without inventing a model completion", async () => {
  const promptFeedback = { blockReason: "SAFETY", blockReasonMessage: "Blocked upstream" }
  const output = await (await adaptResponse(sseResponse(event({ promptFeedback, usageMetadata: { promptTokenCount: 9 } })), false)).json()
  assert.deepEqual(output, { candidates: [], promptFeedback, usageMetadata: { promptTokenCount: 9 } })
})

test("aborting nonstream aggregation rejects with the caller reason and cancels upstream", async () => {
  const abort = new AbortController()
  let signalPull
  const pulled = new Promise((resolve) => { signalPull = resolve })
  let cancellationReason
  const upstream = new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(event({ candidates: [{ content: { parts: [{ text: "partial" }] } }] }))) },
    pull() { signalPull() },
    cancel(reason) { cancellationReason = reason },
  }), { headers: { "content-type": "text/event-stream" } })
  const pending = adaptResponse(upstream, false, { signal: abort.signal })
  await pulled
  const reason = new DOMException("Consumer stopped", "AbortError")
  abort.abort(reason)
  await assert.rejects(pending, (error) => error === reason)
  assert.equal(cancellationReason, reason)
})

test("preserves streaming cancellation through the original body", async () => {
  let cancellationReason
  const upstream = new Response(new ReadableStream({
    cancel(reason) { cancellationReason = reason },
  }), { headers: { "content-type": "text/event-stream" } })
  const reason = new Error("Stream reader stopped")
  await (await adaptResponse(upstream, true)).body.cancel(reason)
  assert.equal(cancellationReason, reason)
})

test("propagates an upstream abort while aggregating instead of returning partial JSON", async () => {
  const abort = new AbortController()
  let signalPull
  const pulled = new Promise((resolve) => { signalPull = resolve })
  const upstream = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(event({ candidates: [{ content: { parts: [{ text: "partial" }] } }] })))
      abort.signal.addEventListener("abort", () => controller.error(abort.signal.reason), { once: true })
    },
    pull() { signalPull() },
  }), { headers: { "content-type": "text/event-stream" } })
  const pending = adaptResponse(upstream, false)
  await pulled
  const reason = new DOMException("Request aborted", "AbortError")
  abort.abort(reason)
  await assert.rejects(pending, (error) => error === reason)
})

test("does not hide malformed upstream events as a successful empty response", async () => {
  await assert.rejects(adaptResponse(sseResponse('data: {"candidates":broken}\n\n'), false), SyntaxError)
})

// These error fixtures exercise the generic Google RPC error contract; they
// are not captured Antigravity App responses or evidence of model entitlement.
test("returns a Google error before any content as a non-success JSON response", async () => {
  const error = {
    code: 403,
    status: "PERMISSION_DENIED",
    message: "The caller does not have permission",
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "IAM_PERMISSION_DENIED", domain: "googleapis.com", metadata: { permission: "aiplatform.endpoints.predict" } }],
  }
  const result = await adaptResponse(sseResponse(event({ error })), false)
  assert.equal(result.status, 403)
  assert.equal(result.ok, false)
  assert.equal(result.headers.get("content-type"), "application/json")
  assert.deepEqual(await result.json(), { error })
})

test("discards partial content when a later Google error ends the stream and cancels upstream", async () => {
  const error = { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "5s" }] }
  let canceled = false
  const upstream = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(event({ candidates: [{ index: 0, content: { parts: [{ text: "Incomplete answer" }] } }] })))
      controller.enqueue(encoder.encode(event({ error }) + event({ candidates: [{ index: 0, finishReason: "STOP" }] })))
    },
    cancel() { canceled = true },
  }), { headers: { "content-type": "text/event-stream" } })
  const result = await adaptResponse(upstream, false)
  assert.equal(result.status, 429)
  assert.deepEqual(await result.json(), { error })
  assert.equal(canceled, true)
})

test("handles named error events with wrapped or direct Google errors before or after partial content", async () => {
  const error = { code: 503, status: "UNAVAILABLE", message: "The service is temporarily unavailable" }
  for (const partial of ["", event({ candidates: [{ content: { parts: [{ text: "partial" }] } }] })]) {
    for (const payload of [{ error }, error]) {
      const raw = partial + "event: error\r\n" + event(payload, "\r\n\r\n") + event({ candidates: [{ finishReason: "STOP" }] })
      const result = await adaptResponse(sseResponse(raw, [1]), false)
      assert.equal(result.status, 503)
      assert.deepEqual(await result.json(), { error })
    }
  }
})

test("uses a canonical Google status when the error has no HTTP code", async () => {
  const error = { status: "DEADLINE_EXCEEDED", message: "Request deadline exceeded" }
  const result = await adaptResponse(sseResponse(event({ error })), false)
  assert.equal(result.status, 504)
  assert.deepEqual(await result.json(), { error })
})

test("fails closed on malformed Google errors and named error payloads", async () => {
  const malformed = [
    event({ error: null }),
    event({ error: "Unavailable" }),
    event({ error: {} }),
    event({ error: { code: 200, message: "Invalid success code" } }),
    event({ error: { code: "503", message: "Invalid code type" } }),
    event({ error: { code: 503, message: 42 } }),
    "event: error\n" + event({ candidates: [] }),
    "event: error\n" + event(null),
    "event: error\n" + event([]),
    "event: error\n\n",
    "event: error\ndata: [DONE]\n\n",
    'event: error\ndata: {"error":broken}\n\n',
  ]
  for (const raw of malformed) {
    for (const partial of ["", event({ candidates: [{ content: { parts: [{ text: "partial" }] } }] })]) {
      await assert.rejects(adaptResponse(sseResponse(partial + raw), false), (error) => error instanceof TypeError || error instanceof SyntaxError)
    }
  }
})

test("passes streamed error events through byte for byte without choosing a new status", async () => {
  const raw = event({ candidates: [{ content: { parts: [{ text: "partial" }] } }] }) + "event: error\n" + event({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } })
  const upstream = sseResponse(raw, [1])
  const result = await adaptResponse(upstream, true)
  assert.equal(result, upstream)
  assert.equal(result.status, 200)
  assert.equal(await result.text(), raw)
})

test("cancels a nonstream upstream body for an already aborted caller", async () => {
  const abort = new AbortController()
  const reason = new DOMException("Aborted before aggregation", "AbortError")
  abort.abort(reason)
  let cancellationReason
  const upstream = new Response(new ReadableStream({
    cancel(value) { cancellationReason = value },
  }), { headers: { "content-type": "text/event-stream" } })
  await assert.rejects(adaptResponse(upstream, false, { signal: abort.signal }), (error) => error === reason)
  assert.equal(cancellationReason, reason)
})

test("cancels upstream when an event cannot be parsed instead of returning partial content", async () => {
  let canceled = false
  const upstream = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(event({ candidates: [{ content: { parts: [{ text: "partial" }] } }] }) + 'data: {"error":broken}\n\n'))
    },
    cancel() { canceled = true },
  }), { headers: { "content-type": "text/event-stream" } })
  await assert.rejects(adaptResponse(upstream, false), SyntaxError)
  assert.equal(canceled, true)
})

test("cancels upstream after a completed signed response without altering the signature", async () => {
  const signedPart = { functionCall: { id: "lookup:final", name: "lookup", args: { query: "東京" } }, thoughtSignature: "c2lnbmVkLXRvb2wtY2FsbA==" }
  let canceled = false
  const upstream = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(event({ candidates: [{ index: 0, content: { role: "model", parts: [signedPart] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 12 } }) + "data: [DONE]\n\n"))
    },
    cancel() { canceled = true },
  }), { headers: { "content-type": "text/event-stream" } })
  const result = await adaptResponse(upstream, false)
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), {
    candidates: [{ index: 0, content: { role: "model", parts: [signedPart] }, finishReason: "STOP" }],
    usageMetadata: { totalTokenCount: 12 },
  })
  assert.equal(canceled, true)
})
