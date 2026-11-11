import test from "node:test"
import assert from "node:assert/strict"
import { quotaUsage } from "./usage.mjs"

test("live-shaped groups keep exhausted and available models in distinct scopes", () => {
  const summary = {
    description: "Separate model allowances report their closest limit.",
    groups: [{
      displayName: "All Models",
      description: "Limits depend on the selected model.",
      buckets: [
        { bucketId: "gemini-3.8-flash-low", displayName: "Gemini Flash Low", remainingFraction: 0 },
        { bucketId: "claude-sonnet-4-5", displayName: "Claude Sonnet", remainingFraction: 1 },
      ],
    }],
  }
  const result = quotaUsage(summary, { metadata: { tierDisplayName: "Enterprise Standard", userTier: "standard" } })
  assert.equal(result.plan, "Enterprise Standard")
  assert.deepEqual(result.windows, [
    { name: "All Models · Gemini Flash Low", used: 100, models: ["gemini-3.8-flash-low"] },
    { name: "All Models · Claude Sonnet", used: 0, models: ["claude-sonnet-4-5"] },
  ])
  assert.ok(result.windows.every((window) => window.models?.length === 1))
  assert.ok(result.windows.every((window) => !Object.hasOwn(window, "display")))
  assert.ok(result.windows.every((window) => !Object.hasOwn(window, "pool") && !Object.hasOwn(window, "family")))
  assert.ok(result.windows.every((window) => !window.models.includes("catalog-only-model")))
  assert.ok(result.windows.every((window) => !Object.hasOwn(window, "resetsAt") && !Object.hasOwn(window, "span") && !Object.hasOwn(window, "amount") && !Object.hasOwn(window, "limit") && !Object.hasOwn(window, "balance")))
})

test("unknown fractions use an unknown message while numeric buckets omit display overrides", () => {
  const { windows } = quotaUsage({ groups: [{ displayName: "Model limits", description: "Vendor cadence description", buckets: [
    { bucketId: "gemini-3.8-flash-low", displayName: "Flash", description: "Bucket description" },
    { bucketId: "claude-sonnet-4-5", displayName: "Claude", description: "Another description", remainingFraction: 0.5 },
  ] }] })
  assert.equal(windows[0].display, "Usage unknown")
  assert.equal(Object.hasOwn(windows[0], "used"), false)
  assert.equal(windows[1].used, 50)
  assert.equal(Object.hasOwn(windows[1], "display"), false)
})

test("only explicit finite numeric remaining fractions in range supply usage", () => {
  const fractions = [undefined, null, "0", "1", NaN, Infinity, -Infinity, -0.01, 1.01, false]
  const buckets = [
    { bucketId: "gemini-3.8-flash-low", displayName: "Missing fraction" },
    ...fractions.map((remainingFraction, index) => ({ bucketId: "gemini-3.8-flash-low", displayName: `Invalid ${index}`, remainingFraction })),
    { bucketId: "gemini-3.8-flash-low", displayName: "Partly used", remainingFraction: 0.75 },
  ]
  const { windows } = quotaUsage({ groups: [{ displayName: "Model limits", buckets }] })
  assert.equal(windows.length, buckets.length)
  assert.ok(windows.slice(0, -1).every((window) => !Object.hasOwn(window, "used") && window.display === "Usage unknown"))
  for (const window of windows) assert.deepEqual(window.models, ["gemini-3.8-flash-low"])
  assert.equal(windows.at(-1).used, 25)
})

test("tiny positive remaining quota stays below exhaustion without rounding", () => {
  const fractions = [0.000001, Number.EPSILON, Number.MIN_VALUE]
  const { windows } = quotaUsage({ groups: [{ displayName: "All Models", buckets: [
    ...fractions.map((remainingFraction) => ({ bucketId: "gemini-3.8-flash-low", displayName: "Flash", remainingFraction })),
    { bucketId: "gemini-3.8-flash-low", displayName: "Exhausted", remainingFraction: 0 },
    { bucketId: "gemini-3.8-flash-low", displayName: "Unknown" },
  ] }] })
  assert.equal(windows[0].used, (1 - 0.000001) * 100)
  for (const window of windows.slice(0, fractions.length)) assert.ok(window.used < 100 && window.used > 99)
  assert.equal(windows[fractions.length].used, 100)
  assert.equal(Object.hasOwn(windows[fractions.length + 1], "used"), false)
})

test("missing or invalid bucket ids remain display-only even when exhausted", () => {
  const buckets = [
    { bucketId: "antigravity-enterprise/gemini-3.8-flash-low", displayName: "Qualified id", remainingFraction: 0 },
    { bucketId: " gemini-3.8-flash-low", displayName: "Padded id", remainingFraction: 0 },
    { bucketId: "gemini flash", displayName: "Whitespace in id", remainingFraction: 0 },
    { bucketId: "", displayName: "Empty id", remainingFraction: 0 },
    { bucketId: 42, displayName: "Numeric id", remainingFraction: 0 },
    { displayName: "No id", remainingFraction: 0 },
  ]
  const { windows } = quotaUsage({ groups: [{ displayName: "All Models", buckets }] })
  assert.equal(windows.length, buckets.length)
  for (const window of windows) {
    assert.equal(window.used, 100)
    assert.equal(window.aside, true)
    assert.equal(Object.hasOwn(window, "models"), false)
  }
})

test("unfamiliar upstream ids stay precisely scoped without a loaded model catalog", () => {
  const { windows } = quotaUsage({ groups: [{ displayName: "All Models", buckets: [
    { bucketId: "future-vendor-model", displayName: "Future allowance", remainingFraction: 0 },
  ] }] })
  assert.deepEqual(windows, [{ name: "All Models · Future allowance", used: 100, models: ["future-vendor-model"] }])
})

test("groups and repeated buckets remain independent without inferred shared windows", () => {
  const { windows } = quotaUsage({ groups: [
    { displayName: "First group", buckets: [{ bucketId: "gemini-3.8-flash-low", displayName: "Flash", remainingFraction: 0.5 }] },
    { displayName: "Second group", buckets: [{ bucketId: "gemini-3.8-flash-low", displayName: "Flash", remainingFraction: 1 }] },
    { displayName: "Unknown group", description: "No limits reported", buckets: [] },
  ] })
  assert.deepEqual(windows, [
    { name: "First group · Flash", used: 50, models: ["gemini-3.8-flash-low"] },
    { name: "Second group · Flash", used: 0, models: ["gemini-3.8-flash-low"] },
    { name: "Unknown group", display: "No limits reported", aside: true },
  ])
})

test("the saved verified tier is the only source of plan metadata", () => {
  const summary = { plan: "Untrusted response plan", userTier: "response-tier", groups: [] }
  assert.deepEqual(quotaUsage(summary), { windows: [] })
  assert.deepEqual(quotaUsage(summary, { metadata: { tierDisplayName: "  ", userTier: "verified-tier" } }), { plan: "verified-tier", windows: [] })
  assert.deepEqual(quotaUsage(summary, { metadata: { tierDisplayName: "Verified enterprise", userTier: "verified-tier" } }), { plan: "Verified enterprise", windows: [] })
})

test("an empty groups list is unknown and malformed structures report clear errors", () => {
  assert.deepEqual(quotaUsage({ groups: [] }), { windows: [] })
  for (const summary of [null, [], {}, { groups: null }, { groups: {} }, { groups: "groups" }]) {
    assert.throws(() => quotaUsage(summary), /invalid groups list/)
  }
  assert.throws(() => quotaUsage({ groups: [null] }), /invalid quota group/)
  assert.throws(() => quotaUsage({ groups: [{ buckets: {} }] }), /invalid quota group/)
  assert.throws(() => quotaUsage({ groups: [{ buckets: [null] }] }), /invalid quota bucket/)
})
