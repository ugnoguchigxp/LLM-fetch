# tauri-plugin-llm-fetch

`tauri-plugin-llm-fetch` is a Cargo-only Tauri 2 plugin for bounded retrieval
through a hidden, incognito WebView. It has no npm package, Node.js sidecar,
Playwright dependency, browser download, or HTTP-first fallback. JavaScript is
rendered by the WebView bundled with the operating system.

macOS 14 or newer is the supported production target. Windows and Linux report
best-effort support and are rejected by default when
`requireReliableBackground` is enabled.

## Install

During monorepo development:

```toml
[dependencies]
tauri-plugin-llm-fetch = { path = "../llm-fetch/crates/tauri-plugin-llm-fetch" }
```

Register the plugin in the Tauri backend:

```rust
tauri::Builder::default()
  .plugin(tauri_plugin_llm_fetch::init())
  .run(tauri::generate_context!())
  .expect("failed to run Tauri");
```

Add `llm-fetch:default` to the capability of each frontend window allowed to
call it. The default permission includes `status`, `create_session`, `fetch`,
`cancel`, and `close_session`.

## Configure

Configuration belongs under `plugins.llm-fetch` in `tauri.conf.json`:

```json
{
  "plugins": {
    "llm-fetch": {
      "allowedHosts": ["example.com", "*.example.org"],
      "maxSessions": 2,
      "requestTimeoutMs": 30000,
      "sessionIdleTimeoutMs": 300000,
      "requireReliableBackground": true,
      "allowHttp": false
    }
  }
}
```

The application allowlist is an upper bound. A reusable session must not use
the catch-all `*`; exact hosts and subdomain patterns such as `*.example.org`
are supported. `fetch` without `sessionId` creates and destroys an internal
one-shot WebView; `fetch` with `sessionId` serializes navigation on the
session's WebView. Idle reusable sessions are destroyed automatically.

The frontend calls the normal Tauri command namespace:

```js
const document = await window.__TAURI__.core.invoke("plugin:llm-fetch|fetch", {
  request: {
    requestId: crypto.randomUUID(),
    url: "https://example.com/",
    requestedUse: "summarize"
  }
});
```

See `examples/tauri-background-fetch` for an npm-free interactive app. Run its
real WebView smoke test with:

```sh
cargo run -p tauri-background-fetch -- --self-test-fast
```

All self-test modes keep both the example window and worker WebViews hidden,
non-focusable, absent from the taskbar, and never always-on-top.
`--self-test-long` reuses a hidden WebView at 0, 2, 6, and 10 minutes.
`--self-test-leak` performs 100 complete one-shot create/fetch/destroy cycles.
`--self-test-reuse` performs 100 navigations in one reusable session.
`--self-test-boundary` verifies that a cross-origin subresource outside the
session allowlist fails the whole request and invalidates the session. It also
checks that two navigations after an `Alt-Svc: h3` response still traverse the
loopback proxy, and that cookies persist within one reusable session but do not
cross into another incognito WebView. It also verifies bounded extraction when
the page continuously mutates its DOM, and when a single hidden node contains
100,000 characters, plus queue, cancellation, close, and registry cleanup
behavior. The fast and boundary modes use public HTTPS canaries and therefore
require network access.

See the repository's
[validation record](https://github.com/ugnoguchigxp/LLM-fetch/blob/main/docs/TAURI_PLUGIN_VALIDATION.md)
for the latest release-gate evidence and the exact commands used.

## Security contract

- HTTPS is the default. Plain HTTP is available only with `allowHttp: true` and
  the proxy accepts only absolute-form GET/HEAD requests with no body.
- Userinfo, explicit ports, literal IPs, localhost/local names, and non-public
  IPv4/IPv6 ranges are rejected. Every DNS answer must be public; connections
  use only those validated answers.
- A loopback proxy is active only during a fetch. HTTPS CONNECT and optional
  HTTP forwarding enforce host policy, connection caps, per-tunnel limits, and
  aggregate per-request sent/received budgets. All request-generation tasks are
  cancelled and joined during cleanup.
- Top-level navigation is independently allowlisted and limited to eight
  accepted HTTP(S) transitions. Popups and downloads are denied. After each
  successful reusable fetch, the worker returns to a static plugin-owned page
  with no consumer application code. `window.name` is cleared at every
  document start so it cannot carry data into the next navigation.
- WebSocket, WebTransport, WebRTC, EventSource, Worker, SharedWorker, Service
  Worker registration, media capture, geolocation, clipboard, credentials,
  device pickers, file pickers, dialogs, sharing, beacon, popup, and
  notification paths are disabled by an initialization script in every frame.
- Visible text is separated from hidden, comment, meta, template, and selected
  attribute segments. DOM, depth, candidate, text, security-segment, callback,
  and inspection limits are enforced in JavaScript and checked again in Rust.
- Redirected final URLs are revalidated. Returned content always has
  `fetchMethod: "tauri_webview"`, `trust: "untrusted"`, and `tainted: true`.
  Guard decisions are advisory data and never grant tool authority.

This is a retrieval boundary, not an OS sandbox or authenticated browser. Do
not place secrets, application cookies, Node bindings, or privileged Tauri
capabilities in the worker. See the repository `SECURITY.md` for residual risks.
