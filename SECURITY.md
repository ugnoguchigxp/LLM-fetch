# Security policy

## Supported versions

Security fixes are applied to the latest published minor release while the package is in the `0.x` series.

## Reporting a vulnerability

Do not include secrets, private URLs, fetched page bodies, or production credentials in a public issue. Use the repository host's private security-advisory feature when available.

## Security boundaries

`llm-fetch` blocks non-public network destinations, pins validated DNS answers to the outbound connection, revalidates redirects, bounds compressed and decoded responses, restricts content types, and applies a total deadline.

All search results and retrieved documents are untrusted. The Context Guard detects a bounded set of prompt-injection patterns and removes hidden HTML from returned text. No finding is a safety guarantee. Core HTTP mode does not evaluate external CSS or execute JavaScript. Optional Playwright mode executes untrusted JavaScript in a fresh context and adds computed-style visibility inspection, but it does not provide authorization for write tools, external messages, code execution, memory changes, or policy changes.

Playwright mode uses request interception and an authenticated loopback DNS-pinning proxy, permits only GET and HEAD, blocks Service Workers, WebSockets, other methods, subframes, downloads, popups, and browser permissions, and does not load application cookies or storage state. Rendered DOM inspection runs in a Chromium isolated world so page JavaScript cannot replace the DOM APIs used by the computed-visibility check. Shadow DOM is not extracted. These controls are not an OS-level sandbox. WebRTC and future browser features may create additional egress paths, so hosts with access to private or metadata networks must also enforce container, network-namespace, or firewall egress policy. Do not pass secrets, Node.js bindings, authenticated browser profiles, or high-impact tools into the page.

Chromium's process sandbox is enabled by default. The `externalSandbox` option disables that process sandbox and is only appropriate when an independently enforced deployment sandbox provides equivalent isolation.

The optional browser extension is inactive unless a browser retriever is configured. `auto` guards the HTTP response before a browser fallback. `always` avoids the first fetch and therefore cannot inspect raw HTML before page JavaScript executes. In `auto` mode the browser is inactive when `playwright-core` or the matching Chromium executable is absent. The package never downloads a browser at runtime.

Applications integrating this package must preserve the returned taint and provenance metadata, structurally separate tool output from instructions, and apply independent authorization before high-impact actions.

Direct `search()` results and the `hits` returned by `searchAndRead()` remain untrusted external strings. The LLM toolset applies an additional guard and withholds high-risk hits; direct API consumers must provide equivalent structural separation if they pass search metadata to a model.

Supplying a custom `fetcher` replaces the built-in outbound transport and therefore moves SSRF, DNS rebinding, redirect, response-size, content-type, and timeout enforcement to that implementation. Returned URLs are checked for valid public HTTP(S) shape, but the client cannot attest which IP a custom transport contacted. Ignoring `AbortSignal` leaves the custom operation running after the client stops waiting.

## Tauri background WebView plugin

`tauri-plugin-llm-fetch` is a separate Cargo-only transport. It never invokes
the npm package, Playwright, a sidecar, or a separately downloaded browser.
The worker is hidden and incognito, has no remote Tauri capability, and uses an
ephemeral loopback proxy that is enabled only for the lifetime of one fetch.
The proxy validates every DNS answer, connects to a selected validated address,
revalidates final URLs, and enforces tunnel and aggregate request budgets.

The loopback listener is not an authentication boundary. Another process under
the same OS account could race to use its ephemeral port while a fetch is
active. Run untrusted local processes under a separate account or sandbox and
use host firewall/egress controls when that threat is in scope.

The bootstrap and extractor run in the page's JavaScript world. They are
installed before page code, keep required primitives, expose non-configurable
entry points, bound their output, and Rust rejects invalid schemas and oversized
callbacks. This prevents page content from becoming Tauri IPC or authority, but
it does not prevent JavaScript denial of service or guarantee that future
WebView APIs cannot create a new egress path. Worker, SharedWorker, Service
Worker registration, WebSocket, WebTransport, EventSource, WebRTC, media
capture, geolocation, clipboard, credential/device/file pickers, sharing,
beacon, popup, dialogs, and notification paths are disabled. Production hosts
should still deny private and metadata egress outside the process.

Top-level HTTP(S) navigation has a second synchronous host-policy gate and an
eight-navigation ceiling. A successful reusable fetch is reset to a static
plugin-owned internal document before its network generation is disabled. The
internal document does not load the consumer application's frontend assets and
the worker label must not appear in a Tauri capability. The document-start
bootstrap also clears `window.name` before page code can use a value retained
from the previous navigation.

CONNECT carries end-to-end TLS, so the proxy cannot remove encrypted response
headers such as `Alt-Svc`. The supported macOS gate therefore includes a real
WebView smoke workflow; HTTP responses handled directly by the proxy strip
`Alt-Svc`. Treat an OS/WebView update that restores QUIC, WebRTC, or another
proxy-bypass path as a security regression and disable the plugin until it is
revalidated.

Incognito storage is isolation, not authentication. The plugin is intended for
public, unauthenticated pages. Do not inject application cookies, credentials,
client certificates, secrets, privileged JavaScript bridges, or write-capable
tools into the worker. Prompt-injection findings are heuristic; every returned
document remains `untrusted` and `tainted` even when no finding is present.

Applications must not register side-effecting custom URI schemes that remote
WebViews can reach. The plugin gates top-level navigation to its own internal
scheme and public HTTP(S), but the operating-system WebView may dispatch a
page-initiated custom-scheme subresource outside the HTTP proxy. Keep consumer
custom protocols read-only and independently authenticate and authorize every
request; never expose secrets or mutation through scheme possession alone.
