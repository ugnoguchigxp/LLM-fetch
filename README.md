# llm-fetch

Fast, dependency-light web search and safe content retrieval for Node.js LLM applications.

The package is implemented in TypeScript, requires Node.js 22 or later, and enables its built-in Context Guard by default. The core package does not require Python, Docker, a browser, SearXNG, Prompt Shield, or WebAssembly. Playwright/Chromium support is an optional dynamic-page extension.

> The package name uses the temporary `@scope` placeholder and is marked `private` to prevent an accidental release. Replace the scope and remove `private` before the first npm publish.

## Install

```sh
npm install @scope/llm-fetch
```

## DuckDuckGo

```ts
import { createLlmFetch, duckDuckGo } from "@scope/llm-fetch";

const web = createLlmFetch({
  search: duckDuckGo(),
});

const result = await web.searchAndRead({
  query: "TypeScript web retrieval",
  limit: 5,
});

for (const document of result.documents) {
  console.log(document.title, document.finalUrl);
  console.log(document.security);
  console.log(document.text);
}
```

DuckDuckGo first uses the regular search bootstrap and its provider-signed `links.duckduckgo.com/d.js` preload. The preload URL, host, path, query, and VQD token are validated, and the result array is parsed as data without evaluating the returned JavaScript. If that route has a retryable challenge, transport failure, or parser change, the provider falls back to DuckDuckGo's documented non-JavaScript HTML and Lite representations.

All three representations are best-effort web interfaces rather than a stable application API. They may change or return rate limits and bot challenges; after the bounded fallback sequence, such responses are returned as typed errors rather than empty results. This implementation does not depend on SearXNG or include AGPL code.

Search queries are bounded to 400 characters across providers. Brave `timeRange` values are mapped to its freshness filters, while `locale` is passed as `search_lang`. The client bounds the entire configured search chain to 10 seconds by default; use `searchTimeoutMs` to change it. Provider-specific deadlines remain shorter by default. DuckDuckGo challenges and DuckDuckGo/Brave rate limits also start an in-memory cooldown so repeated calls do not immediately repeat the blocked request.

## DuckDuckGo with Brave fallback

```ts
import {
  brave,
  createLlmFetch,
  duckDuckGo,
  fallbackSearch,
} from "@scope/llm-fetch";

const web = createLlmFetch({
  search: fallbackSearch([
    duckDuckGo({ timeoutMs: 2_500 }),
    brave({ apiKey: process.env.BRAVE_SEARCH_API_KEY! }),
  ]),
});
```

Fallback occurs only after a typed retryable error. An empty result or invalid input does not trigger the next provider.

## Read one URL

```ts
const document = await web.read({
  url: "https://example.com/article",
  maxCharacters: 20_000,
  requestedUse: "answer_with_citation",
});
```

Only public HTTP/HTTPS destinations on their standard ports are allowed. DNS results are validated and pinned for the connection, every redirect is revalidated, and compressed and decoded bodies have separate limits.

## Optional dynamic pages with Playwright

Install the optional Chromium helper when browser-rendered pages are needed. It downloads the matching browser during installation; core-only users should not install it.

```sh
npm install @scope/llm-fetch @playwright/browser-chromium
```

Alternatively, manage the browser binary explicitly:

```sh
npm install @scope/llm-fetch playwright-core
npx playwright-core install --only-shell chromium
```

```ts
import { createLlmFetch, duckDuckGo } from "@scope/llm-fetch";
import { playwrightRetriever } from "@scope/llm-fetch/playwright";

const web = createLlmFetch({
  search: duckDuckGo(),
  browser: {
    retriever: playwrightRetriever({ concurrency: 2 }),
    defaultRender: "auto",
  },
});

const document = await web.read({
  url: "https://example.com/app",
  render: "auto",
});
```

`auto` always tries the fast HTTP path first. Chromium is launched only when the static response is a likely client-rendered shell or fails the readable-content quality threshold. If `playwright-core` or its Chromium binary is absent, `auto` does not switch and preserves the original `CONTENT_INSUFFICIENT` result. `always` is an explicit programmatic mode and reports `CONFIG_MISSING` when the optional runtime is unavailable.

HTTP retrieval, browser queueing, navigation, DOM settling, extraction, and guards share one 15-second `read` deadline. Configure `readTimeoutMs` on `createLlmFetch` when a different bound is required; a browser fallback does not reset the timer.

The browser process is reused, but each retrieval uses a new non-persistent BrowserContext. The extension blocks non-GET requests, subframes, popups, downloads, WebSockets, Service Workers, private network destinations, and unnecessary image/media/font resources. The rendered DOM is inspected in a Chromium isolated world so page scripts cannot replace the DOM APIs used by the visibility check. Rendered HTML is passed through the same Context Guard, including computed-hidden content. The LLM `fetch_content` tool does not expose the `render` option.

Chromium's process sandbox is enabled by default. `externalSandbox: true` delegates that isolation to the deployment environment and should be used only inside an independently enforced container or sandbox.

Browser routing and the built-in DNS-pinning proxy are defense in depth, not an operating-system network sandbox. Deploy browser mode with container or egress isolation when the host can reach sensitive networks.

## LLM tool definitions

```ts
const toolset = web.toolset();

const openaiTools = toolset.openaiDefinitions();
const bedrockTools = toolset.bedrockDefinitions();

const output = await toolset.execute("web_search", {
  query: "Node.js HTTP security",
  limit: 5,
});
```

OpenAI and AWS SDKs are not runtime dependencies. Search snippets that contain high-severity injection patterns are withheld from the tool output. Retrieved documents that require approval or are denied are returned as `GUARD_DENIED` errors instead of content.

The toolset is intentionally smaller than the lower-level SDK result. `web_search` defaults to five results and caps each title and snippet. `fetch_content` defaults to 5,000 visible characters, has a model-facing maximum of 20,000, and returns only the final citation URL, readable text, retrieval time, and truncation flag. Its output never contains the page title, HTML structure, scripts, styles, control attributes, hidden content, raw response metadata, or verbose guard findings. Security metadata is reduced to the trust marker, decision, and unique actionable warning categories. Use `read()` when trusted application code needs the title, up to 100,000 characters, or the full provenance and diagnostic envelope.

The lower-level `search()` API and the `hits` array in `searchAndRead()` are normalized transport data, but their titles and snippets still originate outside the application. Treat them as untrusted and do not concatenate them into model instructions. Use the toolset path when search results are going directly to an LLM because it adds guard decisions and withholds high-risk hits.

## Context Guard

Every retrieved document is marked `trust: "untrusted"` and `tainted: true`, including documents with no findings.

The built-in guard:

- separates visible text, hidden text, comments, metadata, templates, and low-trust attributes;
- removes statically hidden content from LLM-visible text;
- scans bounded Unicode, zero-width, URL/hex escape, Base64, delimiter, and leetspeak variants;
- detects instruction override, role redefinition, secret disclosure, tool execution, external sending, memory writes, policy changes, source suppression, and output control;
- applies the requested use when deciding whether to allow, warn, require approval, or deny;
- never returns raw HTML in a document or tool result.

The guard is defense in depth, not a proof of safety. Core HTTP mode does not evaluate external stylesheets or computed CSS; optional browser mode performs bounded computed-visibility checks, but heuristic rules still cannot identify every semantic attack. Applications must keep write tools, code execution, external sending, memory updates, and policy changes behind a separate application-level authorization gate.

Strict mode raises selected medium-severity findings:

```ts
const web = createLlmFetch({
  search: duckDuckGo(),
  contextGuard: { profile: "strict" },
});
```

An additional organization-specific guard can be supplied. It cannot replace the built-in guard; the stricter decision wins.
Additional guards have a five-second deadline by default; configure `additionalGuardTimeoutMs` when a local guard needs a different bound. Returned findings, reasons, limitations, and individual strings are size-bounded and validated before they are merged.

`fetcher` is an advanced testing/integration override. Supplying one replaces the built-in SSRF-safe HTTP transport, so production overrides must enforce equivalent URL, DNS, redirect, size, content-type, and timeout controls.

Custom search providers, retrievers, fetchers, and guards must honor the supplied `AbortSignal`. The client bounds how long it waits even when an override ignores cancellation, but it cannot stop work or side effects inside a non-cooperative implementation.

## Errors

```ts
import { LlmFetchError } from "@scope/llm-fetch";

try {
  await web.read({ url: "http://127.0.0.1/admin" });
} catch (error) {
  if (error instanceof LlmFetchError) {
    console.error(error.code, error.retryable);
  }
}
```

Built-in providers and transport do not place fetched HTML, search response bodies, cookies, or API keys in error messages. Custom providers, guards, and fetcher overrides must preserve the same rule.

Call and await `web.close()` to clear caches and stop an optional browser/proxy when the client is no longer needed. Closing is idempotent; after it begins, the client is permanently closed and new operations reject with `CONFIG_MISSING`.

```ts
await web.close();
```

## Development

```sh
npm install
npm run verify
npm pack --dry-run

# Optional installed-Chromium integration test
LLM_FETCH_PLAYWRIGHT_INTEGRATION=1 npx vitest run test/playwright/integration.test.ts
```

## License

Apache-2.0. DuckDuckGo and Brave are external services with their own terms and availability constraints.
