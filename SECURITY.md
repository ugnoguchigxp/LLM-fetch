# Security policy

## Supported versions

Security fixes are applied to the latest published minor release while the package is in the `0.x` series.

## Reporting a vulnerability

Do not include secrets, private URLs, fetched page bodies, or production credentials in a public issue. Use the repository host's private security-advisory feature when available.

## Security boundaries

`llm-fetch` blocks non-public network destinations, pins validated DNS answers to the outbound connection, revalidates redirects, bounds compressed and decoded responses, restricts content types, and applies a total deadline.

All search results and retrieved documents are untrusted. The Context Guard detects a bounded set of prompt-injection patterns and removes hidden HTML from returned text. No finding is a safety guarantee. Core HTTP mode does not evaluate external CSS or execute JavaScript. Optional Playwright mode executes untrusted JavaScript in a fresh context and adds computed-style visibility inspection, but it does not provide authorization for write tools, external messages, code execution, memory changes, or policy changes.

Playwright mode uses request interception and an authenticated loopback DNS-pinning proxy, blocks Service Workers, WebSockets, non-GET requests, subframes, downloads, popups, and browser permissions, and does not load application cookies or storage state. Rendered DOM inspection runs in a Chromium isolated world so page JavaScript cannot replace the DOM APIs used by the computed-visibility check. Shadow DOM is not extracted. These controls are not an OS-level sandbox. WebRTC and future browser features may create additional egress paths, so hosts with access to private or metadata networks must also enforce container, network-namespace, or firewall egress policy. Do not pass secrets, Node.js bindings, authenticated browser profiles, or high-impact tools into the page.

Chromium's process sandbox is enabled by default. The `externalSandbox` option disables that process sandbox and is only appropriate when an independently enforced deployment sandbox provides equivalent isolation.

The optional browser extension is inactive unless a browser retriever is configured. In `auto` mode it is also inactive when `playwright-core` or the matching Chromium executable is absent. The package never downloads a browser at runtime.

Applications integrating this package must preserve the returned taint and provenance metadata, structurally separate tool output from instructions, and apply independent authorization before high-impact actions.

Direct `search()` results and the `hits` returned by `searchAndRead()` remain untrusted external strings. The LLM toolset applies an additional guard and withholds high-risk hits; direct API consumers must provide equivalent structural separation if they pass search metadata to a model.

Supplying a custom `fetcher` replaces the built-in outbound transport and therefore moves SSRF, redirect, response-size, content-type, and timeout enforcement to that implementation.
