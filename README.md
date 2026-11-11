# Antigravity Enterprise for Magpie

A local Magpie provider for the enterprise account already signed in to Antigravity App on macOS. Models are exposed as `antigravity-enterprise/<catalog-model-id>`.

## Requirements

- Magpie with OpenCode provider-plugin support.
- Antigravity App installed and signed in to a Google Cloud or Workforce Identity Federation enterprise account.
- macOS login Keychain access. The plugin uses Antigravity's existing `gemini / antigravity` item.
- Xcode Command Line Tools (`xcrun swiftc`) for the first credential renewal. A small Security-framework helper is compiled once and cached; credentials are supplied through stdin, never compiler arguments or source files.

## Install and configure

Clone the repository, then register its local folder with Magpie:

```sh
gh repo clone SteinX/opencode-antigravity-enterprise
cd opencode-antigravity-enterprise
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

The plugin reads the current Keychain credential for requests, renews within five minutes of expiry, and coordinates renewal between requests and plugin-host processes. Native WIF-provider precedence selects the STS OAuth endpoint; enterprise Google Cloud OAuth uses its own installed-app client. Public client metadata is checked against the installed Antigravity binary. Revoked authorization prompts a new sign-in; transient network/server failures remain retryable. A generation rejected with HTTP 401 gets one renewal and one resend; successful generations are never replayed.

Renewed tokens are written to the original Keychain item while preserving its other fields and ACL. A helper holds an OS file lock and checks that the original credential still matches immediately before updating it. The native App does not participate in that lock, and Apple's Keychain API has no atomic value-data compare-and-swap: a native-App write can still race the final comparison and update.

Binding uses an authenticated principal when available, otherwise a successfully renewed refresh-token lineage. Rotations made by this plugin retain that lineage. An unknown externally replaced or rotated token requires explicit rebinding rather than assuming it belongs to the same account. The plugin never selects another native identity merely because its project or provider matches.

Nonsecret principal fingerprints, the compiled helper, and its lock are stored under `~/.config/magpie/antigravity-enterprise`. Package options `appPath` and `stateDir` may change the App path and state directory; all plugin hosts sharing the same native Keychain item must use the same `stateDir` to share its renewal lock.

## Request compatibility

- Reads the installed App's version and native build number; sends matching platform, architecture, and authentication metadata.
- Discovers the selected account's enabled model IDs and capabilities instead of keeping a consumer-model fallback list.
- Routes enterprise inference to the matching global, US, or EU `businessaicode` deployment.
- Uses the flat enterprise Gemini payload, license entitlement, and trajectory/request ID headers.
- Passes native SSE through and aggregates it for nonstreaming clients. Preserves real tool-call IDs, thinking parts, and thought signatures.
- Does not generate telemetry, alter the user's system prompt, insert fabricated signatures, or change the organization's model permissions.

License availability is checked during sign-in; administrator restrictions and upstream authorization errors remain visible. Upstream pricing is not included in this catalog, so the plugin does not claim that a model is free or that an enterprise quota is unused.

## Checks

```sh
node --test auth.test.mjs protocol.test.mjs
```

The deterministic suite covers renewal ownership and cancellation, token replacement races, rotation lineage, per-account configuration preservation, regional routing, fragmented SSE, signatures, tool calls, upstream errors, and cancellation. Live model checks consume the selected enterprise account's allowance.

Validated with Magpie 0.1.3673 and Antigravity App 2.31.0: all 37 deterministic checks passed; forced native renewal preserved account binding and user configuration; live Gemini SSE generation and a real signed tool-call/result continuation succeeded. Magpie's isolated gateway passed OpenAI Chat SSE, OpenAI tool continuation, and Responses translation. The installed daily gateway also listed the provider and completed a real Responses request. US/EU routing is covered by deterministic checks; the live license used global.

## Protocol references

- [Google Antigravity enterprise authentication, licenses, models and endpoints](https://antigravity.google/docs/enterprise)
- [Google Antigravity unified local authentication](https://antigravity.google/docs/install)
- [Magpie provider-plugin contract](https://usemagpie.ai/docs/plugins)
- [Enterprise request-format reference](https://github.com/aeroxy/claude-proxy/blob/b7dd5a943a1f70c7c6a030592757c70a977f666b/src/gemini/aicode.rs)
- [WIF OAuth protocol reference](https://github.com/Mag1cFall/Antigravity2API/blob/6aa1a0a35906abad793f0cef6bebb30c69920ead/docs/protocol.md)
