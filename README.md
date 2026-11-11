# Antigravity Enterprise for Magpie

A local Magpie provider for the enterprise account already signed in to Antigravity App on macOS. Models are exposed as `antigravity-enterprise/<catalog-model-id>`.

## Requirements

- Magpie with provider-plugin support.
- Antigravity App installed and signed in to a Google Cloud or Workforce Identity Federation enterprise account.
- macOS login Keychain access. The plugin uses Antigravity's existing `gemini / antigravity` item.
- Xcode Command Line Tools (`xcrun swiftc`) for the first credential renewal. A small Security-framework helper is compiled once and cached; credentials are supplied through stdin, never compiler arguments or source files.

## Install and configure

Clone the repository, then register its local folder with Magpie:

```sh
gh repo clone SteinX/magpie-antigravity-enterprise
cd magpie-antigravity-enterprise
magpie plugin add .
magpie plugin login antigravity-enterprise
```

The sign-in asks for each account's configuration:

| Field | How to choose it |
| --- | --- |
| Google Cloud Project ID | The project assigned to the enterprise license you want to use. Required. |
| Location | The license location: `global`, `us`, or `eu`. Required; in-country locations such as `us-central1` are not supported by this enterprise-seat API. |
| Authentication | Detect the existing local sign-in, or explicitly require Google Cloud SSO / WIF. |
| WIF Provider | When explicitly selecting WIF, enter the provider supplied by your administrator. It must match the account already signed in to the App. |

Current App values appear as suggestions, not as hidden routing defaults. The license API must confirm the selected project and location before the account is saved. The license tier comes from that response. No personal project, location, provider, or email is embedded in the source.

Changing authentication method or WIF provider requires first signing in with that identity in Antigravity App, then signing in to this Magpie provider again. These fields cannot turn an existing token into another provider's token.

After sign-in, select `antigravity-enterprise/<catalog-model-id>` in Magpie's model picker and send a request from your agent. Some Magpie releases, including the tested 0.1.3673 CLI, reject `provider test` for Google-protocol plugins before sending a request. Use an actual gateway or agent request to verify this provider on those releases.

Run `magpie plugin login antigravity-enterprise` again to configure another permitted project/location or explicitly bind a replacement App sign-in. Configuration is stored per Magpie account. Native license changes do not overwrite an existing account's request target.

## Credentials and renewal

Magpie stores a reference to the bound native account and the user-selected license configuration. It does not receive a copy of the access token or refresh token in `plugin-auth.json`.

The plugin reads the current Keychain credential for requests, renews within five minutes of expiry, and coordinates renewal between requests and plugin-host processes. A nonempty native WIF provider selects the STS OAuth endpoint, including when the stored authentication label is `gcp`; otherwise enterprise Google Cloud OAuth uses its own installed-app client. Explicit authentication choices validate this effective refresh mechanism. Request identity metadata retains the native label. Public client metadata is checked against the installed Antigravity binary. Revoked authorization prompts a new sign-in; transient network/server failures remain retryable. A generation rejected with HTTP 401 gets one renewal and one resend; successful generations are never replayed, and HTTP 403 is not retried as an expired credential.

Renewed tokens are written to the original Keychain item while preserving its other fields and ACL. A helper holds an OS file lock and checks that the original credential still matches immediately before updating it. The native App does not participate in that lock, and Apple's Keychain API has no atomic value-data compare-and-swap: a native-App write can still race the final comparison and update.

Binding uses an authenticated principal when available, otherwise a successfully renewed refresh-token lineage. Rotations made by this plugin retain that lineage. An unknown externally replaced or rotated token requires explicit rebinding rather than assuming it belongs to the same account. The plugin never selects another native identity merely because its project or provider matches.

Nonsecret principal fingerprints, the compiled helper, and its lock are stored under `~/.config/magpie/antigravity-enterprise`. Package options `appPath` and `stateDir` may change the App path and state directory; all plugin hosts sharing the same native Keychain item must use the same `stateDir` to share its renewal lock.

## Request compatibility

- Reads the installed App's version and native build number; sends matching platform, architecture, and authentication metadata.
- Discovers the selected account's enabled model IDs and capabilities instead of keeping a consumer-model fallback list.
- Routes enterprise inference to the matching global, US, or EU `businessaicode` deployment.
- Uses the flat enterprise Gemini payload, license entitlement, and trajectory/request ID headers.
- Accepts standard Fetch `Request`, `URL`, and string inputs, including request-body overrides, headers, and cancellation.
- Preserves `parametersJsonSchema`. Legacy `parameters` containing JSON Schema-only syntax use that field without dropping references, unions, or `additionalProperties`; native Google Schema stays in `parameters`.
- Passes native SSE through and aggregates it for nonstreaming clients. Preserves real tool-call IDs, thinking parts, and thought signatures. Nonstreaming Google RPC errors and named SSE error events return errors instead of partial successful completions; cancellation stops aggregation.
- Does not generate telemetry, alter the user's system prompt, insert fabricated signatures, or change the organization's model permissions.

License availability is checked during sign-in; administrator restrictions and upstream authorization errors remain visible. Upstream pricing is not included in this catalog, so the plugin does not claim that a model is free or that an enterprise quota is unused.

## Checks

```sh
npm test
```

The deterministic suite covers effective authentication selection, renewal ownership and cancellation, token replacement races, rotation lineage, per-account configuration preservation, Fetch input semantics, regional routing, complex tool schemas, fragmented SSE, signatures, tool calls, upstream errors, and cancellation. Error-event fixtures exercise the generic Google RPC/SSE contract; they are not captured App responses. Live model checks consume the selected enterprise account's allowance.

Validated on 2026-11-11 with Magpie 0.1.3673 and Antigravity App 2.31.0: all 103 deterministic checks passed. Forced native renewal, live Gemini SSE generation, signed tool-call/result continuation, OpenAI Chat SSE, and Responses translation were exercised during integration. After the 1.0.1 fixes, the installed daily gateway completed a complex-schema tool call and its result continuation. The same schema containing `$defs`, `$ref`, union types, and `additionalProperties` was rejected by the enterprise API in `parameters` with HTTP 400 and accepted unchanged in `parametersJsonSchema` with HTTP 200. US/EU routing has deterministic coverage; the live license used global.

The official arm64 CLI 1.5.5 artifact was checked against its release-manifest SHA-512 and completed a synthetic one-turn request with status `SUCCESS` and response `OK`. A child-local pass-through proxy observed encrypted connections, including `cloudcode-pa.googleapis.com`; HTTP headers and request bodies were not decrypted. This does not establish that the CLI used this plugin's license configuration or credential source. The plugin's enterprise payload and schema behavior were checked separately against the licensed API, using the user's configured project and location.

## Protocol references

- [Google Antigravity enterprise authentication, licenses, models and endpoints](https://antigravity.google/docs/enterprise)
- [Google Antigravity unified local authentication](https://antigravity.google/docs/install)
- [Magpie provider-plugin contract](https://usemagpie.ai/docs/plugins)
- [Enterprise request-format reference](https://github.com/aeroxy/claude-proxy/blob/b7dd5a943a1f70c7c6a030592757c70a977f666b/src/gemini/aicode.rs)
- [WIF OAuth protocol reference](https://github.com/Mag1cFall/Antigravity2API/blob/6aa1a0a35906abad793f0cef6bebb30c69920ead/docs/protocol.md)
- [Native Google Schema fields](https://googleapis.github.io/js-genai/release_docs/interfaces/types.Schema.html)
- [FunctionDeclaration and JSON Schema parameters](https://googleapis.github.io/js-genai/release_docs/interfaces/types.FunctionDeclaration.html)
- [Official arm64 CLI release manifest](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json)
