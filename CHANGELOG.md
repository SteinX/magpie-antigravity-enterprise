# Changelog

## 1.1.1

Version 1.1.1 verification: 300 behavior tests passed; the unrelated opt-in native Keychain case remained skipped by the default command. A real gateway request to `gemini-4-carbon-low` returned HTTP 429 with the Chinese quota-exhaustion explanation and an upstream-derived reset of `2026-11-18 17:40:57 GMT+08:00`. Magpie continued classifying the attempt and rest reason as `quota`, and the single enabled account remained non-lapsed with no authentication error. Ordinary 429 passthrough, mislabeled JSON error bodies, streaming-request HTTP errors, aggregated SSE quota failures, cancellation, and invalid/missing reset delays have deterministic coverage.

The live account returned 25 buckets matching 25 of its 31 catalog models, each with 100% remaining, and the plan `Gemini Enterprise Plus`; those figures describe that reading and can change.

On 2026-11-12, a direct HTTP 200 read bypassing Magpie's cache still returned `remainingFraction: 1` for all 25 buckets. Earlier captured official-client responses did too. This establishes that 100% was reported upstream; it does not establish zero consumption, unlimited quota, or why the value stayed unchanged after usage. The plugin preserves that reported value instead of estimating consumption from request counts. The API's per-model structure is confirmed; equivalence to the official App's final quota UI is not established.

Later generation requests returned HTTP 429 with `Quota pool exhausted` and a `google.rpc.RetryInfo` reset delay while the quota card still reported 100% remaining. For the affected request, the generation error is the current enforcement result. The quota card remains an independent upstream reading and is not evidence that a rejected model can still generate.

## 1.1.0

Version 1.1.0 verification: 288 behavior tests passed, with the opt-in native Keychain integration test also passing separately. The native fixture covers absent-item installation, guarded replacement, collisions, unchanged ACL restrictions, and ordinary refresh commits that cannot create credentials. A real WIF sign-in was initiated by `magpie plugin login antigravity-enterprise 1`, completed in the browser, validated its license, and saved the native credential. Two subsequent real renewals returned HTTP 200 with `expires_in: 3599` and verified Keychain writeback; a fresh process reused the saved token without interaction or network access. The running gateway returned HTTP 200 and the exact expected Gemini response after account-scoped session handling was applied. One enabled, non-lapsed account remained with 25 quota windows. GCP browser behavior has deterministic protocol coverage; live browser verification used WIF. Tests also cover post-install native replacement and account changes in the same long-running plugin host.

## 1.0.6

Version 1.0.6 accepts native credentials that omit the optional `tier_display_name` field, without adding a default to the Keychain item; invalid supplied types remain rejected. All 248 behavior tests passed (the separate opt-in native integration check is skipped by the default command). After a fresh enterprise sign-in, two consecutive real OAuth renewals returned HTTP 200 with `expires_in: 3599`. Both returned access tokens matched Keychain writeback; the server returned the same refresh token. A fresh process reused the persisted token and expiry with interaction disabled and zero network calls. Explicit provider sign-in re-established the changed native binding; quota refresh returned 25 windows, and the running gateway completed a Gemini Flash Lite request with HTTP 200 and the exact expected response. These checks forced renewal; they did not wait for natural expiry. The earlier 1.0.5 native Keychain integration check passed.

## 1.0.4

Validated with Magpie 0.1.3673 and its Bun 1.4.4 runtime, Antigravity App 2.31.0, and official CLI 1.5.5. All 220 Node deterministic checks passed, including quota fractions, exact model scopes, unknown values, error handling, cancellation, and deadlines. The live Magpie quota refresh returned 25 windows with zero percent used and the expected plan; the scoped gateway history endpoint returned HTTP 200. Earlier integration exercised native renewal, Gemini SSE generation, signed tool-call/result continuation, complex JSON Schema, OpenAI Chat SSE/tools, and Responses translation. The installed daily gateway completed a complex-schema tool call and its result continuation. The same schema containing `$defs`, `$ref`, union types, and `additionalProperties` was rejected by the enterprise API in `parameters` with HTTP 400 and accepted unchanged in `parametersJsonSchema` with HTTP 200. US/EU routing has deterministic coverage; the live license used global.

## Earlier CLI compatibility evidence

The official arm64 CLI 1.5.5 artifact was verified against the release-manifest SHA-512; its executable SHA-256 is `42b591f206a868dd0b924d5b6b396638a108539367695a5dbe2f7dcfdbf4d6f3`. Mitmproxy 12.3.1 decrypted its authentication, catalog, generation, tool-result, and resumed-conversation requests. The CLI used the same native Keychain bearer credential as the provider. Child-process CA overrides supplied trust; no system or login Keychain CA trust was changed. Response chunks were observed and forwarded unchanged.

| Area | Captured official CLI | Provider behavior |
| --- | --- | --- |
| WIF renewal | STS, Basic client authentication with an empty secret; only `grant_type` and `refresh_token` in the form | Matched; real renewal returned HTTP 200 and preserved account binding |
| Generation | Flat `businessaicode` JSON with `aicode`, contents, system instruction, tools, labels, generation config, and entitlement | Replayed through the real loader; decoded JSON was equal after privacy normalization and returned HTTP 200 / `OK` |
| Request IDs | Trajectory UUID plus a counter; native tool requests used 0 and 1, then resumed at 2 in another CLI process | Per-trajectory numbering, with a lower bound from supplied history |
| Tool continuation | Model-role function call and function response; real call ID and thought signature retained | Native-schema replay returned HTTP 200 twice; captured signature and call ID matched the follow-up request |
| Agent context | CLI prompts, cascade labels, experiment/ACL calls, and telemetry | Caller prompts and labels are preserved; CLI agent activity is not synthesized |
| Client identity | `antigravity/cli/1.5.5`, build 1017970541 | Matched; version and build are read from the installed CLI, including after executable replacement |
| HTTP transport | Go HTTP/2 | HTTP/2 in Magpie's Bun 1.4.4 runtime; generation header names and normalized values match, with no extra Accept, connection, host, or content-length headers |

The latest header capture compared the official CLI and the real provider under Magpie's bundled Bun runtime. Catalog discovery returned 31 models and generation returned HTTP 200 / `OK`; the generation User-Agent matched exactly. After normalizing dynamic bearer credentials and UUIDs, all six generation headers and their values matched. Tokens were separately checked against the current native credential. Header order, HTTP/2 SETTINGS/HPACK behavior, connection reuse, and TLS fingerprints are outside this equality check.

The capture covered a WIF-backed native profile whose stored authentication label was `gcp`. Non-WIF cloud OAuth, live regional licenses, and all-model authorization remain unverified. Raw credential values were excluded before evidence was written; detailed redacted captures remain local.
