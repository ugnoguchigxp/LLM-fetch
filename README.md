# llm-fetch

[日本語](./README.ja.md)

`llm-fetch` adds web search and readable-page retrieval to Node.js LLM applications. It treats search results and fetched pages as untrusted input and runs a built-in prompt-injection guard before content reaches a model-facing tool response.

The core package is written in TypeScript and does not require Python, Docker, SearXNG, a browser, or a long-running sidecar. Static pages use the HTTP path. Playwright support is optional and is used only when a page needs JavaScript to produce readable content.

> [!NOTE]
> This repository is being prepared for publication. `@scope/llm-fetch` is a placeholder package name, and `private: true` prevents accidental npm publication. Choose the final scope and remove `private` before publishing.

## Requirements

- Node.js 22 or later
- ESM or CommonJS

Cheerio is the only direct runtime dependency of the core package. OpenAI SDKs, AWS SDKs, Playwright, and browser binaries are not installed with the core package.

## Install

```sh
npm install @scope/llm-fetch
```

## Quick start

```ts
import { createLlmFetch, duckDuckGo } from "@scope/llm-fetch";

const web = createLlmFetch({
  search: duckDuckGo(),
});

try {
  const result = await web.searchAndRead({
    query: "TypeScript web retrieval",
    limit: 5,
  });

  for (const document of result.documents) {
    console.log(document.title, document.finalUrl);
    console.log(document.text);
    console.log(document.security.decision);
  }
} finally {
  await web.close();
}
```

`searchAndRead()` fetches successful search hits concurrently. A page-level failure is added to `failures` without discarding the other documents. A search-provider failure rejects the operation.

| API | Purpose |
| --- | --- |
| `search()` | Return normalized search hits |
| `read()` | Fetch and extract one URL |
| `searchAndRead()` | Search and retrieve result pages in one call |
| `toolset()` | Create OpenAI / Bedrock tool definitions and executors |
| `close()` | Clear caches and stop optional browser/proxy resources |

## Search providers

### DuckDuckGo

DuckDuckGo does not require an API key.

```ts
const web = createLlmFetch({
  search: duckDuckGo(),
});
```

The normal path loads the DuckDuckGo search bootstrap and follows its VQD-bound `links.duckduckgo.com/d.js` preload. The provider validates the preload host, path, query, and VQD token. It parses the result array as data and never evaluates the returned JavaScript.

If that path fails with a retryable challenge, transport error, or response-format change, the provider tries DuckDuckGo's HTML and Lite representations. These are best-effort web interfaces, not a stable application API. Layout changes, rate limits, and bot challenges can still occur. The provider returns typed errors for those cases instead of reporting an empty result set.

The implementation does not use SearXNG or include AGPL code. It does not solve CAPTCHAs or rotate proxies.

### Brave fallback

Use `fallbackSearch()` when Brave Search should run only after a retryable DuckDuckGo failure.

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

An empty result set and invalid input do not advance to the next provider. For Brave, `timeRange` maps to its freshness filter and `locale` maps to `search_lang`.

Search queries are limited to 400 characters. The default deadline for the complete provider chain is 10 seconds and can be changed with `searchTimeoutMs`. DuckDuckGo challenges and DuckDuckGo / Brave rate limits start an in-memory cooldown so repeated calls do not immediately repeat a blocked request.

Use `custom()` to register another implementation of `SearchProvider`.

## Read one URL

```ts
const document = await web.read({
  url: "https://example.com/article",
  maxCharacters: 20_000,
  requestedUse: "answer_with_citation",
});
```

The built-in HTTP transport accepts only public HTTP/HTTPS destinations on their standard ports. It validates DNS results, pins the selected address for the connection, and revalidates every redirect. Compressed and decoded bodies have separate size limits.

`read()` can return up to 100,000 characters for trusted application code. For model context, use the smaller output provided by `toolset()`.

## Optional Playwright support

Install a browser runtime only when client-rendered pages are needed.

```sh
npm install @scope/llm-fetch @playwright/browser-chromium
```

To manage the browser binary separately:

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

`render: "auto"` always tries HTTP first. It switches to Chromium only when the static response does not contain enough readable content and both `playwright-core` and a compatible browser binary are available. If either dependency is missing, the original `CONTENT_INSUFFICIENT` error is preserved. `render: "always"` explicitly requires the browser runtime and returns `CONFIG_MISSING` when it is unavailable.

HTTP retrieval, browser queueing, navigation, extraction, and guards share one 15-second `read` deadline by default. Switching to the browser does not reset that deadline. Set `readTimeoutMs` to use another limit.

The browser process is reused, but every retrieval gets a new non-persistent BrowserContext. The default policy blocks non-GET requests, subframes, popups, downloads, WebSockets, Service Workers, private-network destinations, and unnecessary image, media, and font requests. Rendered-page visibility checks run in an isolated world, and computed-hidden content is included in the guard scan.

Chromium's process sandbox is enabled by default. Use `externalSandbox: true` only when another container or sandbox provides equivalent isolation. Browser routing and the built-in DNS-pinning proxy are defense in depth, not an operating-system network sandbox. Add container or egress isolation when the host can reach sensitive networks.

## Model-facing tools

```ts
const toolset = web.toolset();

const openaiTools = toolset.openaiDefinitions();
const bedrockTools = toolset.bedrockDefinitions();

const output = await toolset.execute("web_search", {
  query: "Node.js HTTP security",
  limit: 5,
});
```

OpenAI and AWS SDKs are not runtime dependencies. Tool definitions are plain JSON objects.

`web_search` returns five results by default and bounds every external title and snippet. Results with high-severity injection patterns are withheld. `fetch_content` returns 5,000 visible characters by default and has a model-facing maximum of 20,000. Its output contains the citation URL, readable text, retrieval time, truncation state, and compact security metadata. It does not expose page HTML, scripts, styles, event attributes, hidden content, raw response metadata, or verbose guard diagnostics.

Titles and snippets returned by the lower-level `search()` API are still untrusted external data. Do not concatenate them into system instructions. Prefer `toolset()` when search output will be sent to a model.

## Context Guard

Every retrieved document is marked `trust: "untrusted"` and `tainted: true`, including documents with no findings. The built-in guard cannot be disabled.

The guard separates visible text, hidden content, comments, metadata, templates, and low-trust attributes. It performs bounded normalization of Unicode, zero-width characters, URL/hex escapes, Base64, delimiter splitting, and leetspeak. It then checks for instruction overrides, role redefinition, secret exfiltration, tool invocation, external sending, memory or policy changes, source suppression, and output control.

Use the strict profile when selected medium-severity findings should be raised:

```ts
const web = createLlmFetch({
  search: duckDuckGo(),
  contextGuard: { profile: "strict" },
});
```

An organization-specific `ContentGuard` can be added but cannot replace the built-in guard. The stricter decision wins. Additional guards have a five-second deadline by default, configurable through `additionalGuardTimeoutMs`. Their returned strings, findings, and reasons are also size-bounded.

Context Guard is not proof that fetched text is safe. Core HTTP mode cannot evaluate visibility from external stylesheets, and browser mode cannot understand every semantic attack. Keep write tools, code execution, external sending, memory updates, and policy changes behind a separate application-level authorization step.

`fetcher` is an advanced testing/integration override. It replaces the SSRF-safe built-in HTTP transport. A production override must enforce equivalent destination, DNS, redirect, body-size, content-type, and timeout checks. Custom providers, retrievers, fetchers, and guards must honor the supplied `AbortSignal`.

## Error handling

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

Built-in providers and transports do not include fetched HTML, search response bodies, cookies, or API keys in error messages. Custom implementations should preserve the same rule.

`close()` is idempotent. Once closing begins, the client cannot be reused and new operations return `CONFIG_MISSING`.

## Development

```sh
npm install
npm run verify
npm pack --dry-run
```

Run the installed-Chromium integration test explicitly:

```sh
LLM_FETCH_PLAYWRIGHT_INTEGRATION=1 \
  npx vitest run test/playwright/integration.test.ts
```

`npm run verify` runs linting, type checks, unit/security tests, production-license checks, ESM/CommonJS/type validation, and a core-only install test.

## License

`llm-fetch` is available under the [MIT License](./LICENSE). DuckDuckGo, Brave, Playwright, Chromium, and other external services or dependencies have their own terms and licenses.
