# llm-fetch

[日本語](./README.ja.md)

`llm-fetch` adds web search and readable-page retrieval to Node.js LLM applications. It treats search results and fetched pages as untrusted input and runs a built-in prompt-injection guard before content reaches a model-facing tool response.

The core package is written in TypeScript and does not require Python, Docker, SearXNG, a browser, or a long-running sidecar. Static pages use the HTTP path. Playwright support is optional and is used only when a page needs JavaScript to produce readable content.

> [!NOTE]
> `llm-fetch` is the final package name. The source manifest remains `private: true` until the separately approved release commit so an unfinished checkout cannot be published accidentally.

## Requirements

- Node.js 20.19 or later, or Bun 1.3.14 or later
- ESM or CommonJS

Cheerio is the only direct runtime dependency of the core package. OpenAI SDKs, AWS SDKs, Playwright, and browser binaries are not installed with the core package.

## Install

```sh
npm install llm-fetch
```

## Quick start

```ts
import { createLlmFetch, duckDuckGo } from "llm-fetch";

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

`searchAndRead()` fetches successful search hits concurrently, with a default limit of two active reads per host (or one when total concurrency is one). A page-level failure is added to `failures` without discarding other documents. If the overall deadline expires after search, completed documents are retained, `timedOut` becomes `true`, and active or unstarted URLs receive distinct failure kinds. A caller `AbortSignal` and a search-provider failure still reject the operation.

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

DuckDuckGo support is experimental and best effort. For production use that requires a contractual API and more predictable availability, use Brave Search or a reviewed custom provider.

The implementation does not use SearXNG or include AGPL code. It does not solve CAPTCHAs or rotate proxies.

### Brave fallback

Use `fallbackSearch()` when Brave Search should run only after a retryable DuckDuckGo failure.

```ts
import {
  brave,
  createLlmFetch,
  duckDuckGo,
  fallbackSearch,
} from "llm-fetch";

const web = createLlmFetch({
  search: fallbackSearch([
    duckDuckGo({ timeoutMs: 2_500 }),
    brave({ apiKey: process.env.BRAVE_SEARCH_API_KEY! }),
  ]),
});
```

An empty result set and invalid input do not advance to the next provider. Use ISO 639-1 `language` values such as `ja` or `en`, and ISO 3166-1 alpha-2 `region` values such as `JP` or `US`. Brave maps these to `search_lang` and `country`; DuckDuckGo maps them to its region code. The older provider-specific `locale` field is deprecated and cannot be combined with the new fields.

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

A search provider is optional when only `read()` or `fetch_content` is needed. In that configuration, `search()` returns `CONFIG_MISSING` and `toolset()` omits `web_search` from every definition format.

## Optional Playwright support

Install a browser runtime only when client-rendered pages are needed.

```sh
npm install llm-fetch @playwright/browser-chromium
```

To manage the browser binary separately:

```sh
npm install llm-fetch playwright-core
npx playwright-core install --only-shell chromium
```

```ts
import { createLlmFetch, duckDuckGo } from "llm-fetch";
import { playwrightRetriever } from "llm-fetch/playwright";

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

`render: "auto"` always retrieves and guards the raw HTTP HTML first. It switches to Chromium only when the guarded static response does not contain enough readable content and both `playwright-core` and a compatible browser binary are available. If either dependency is missing, the original `CONTENT_INSUFFICIENT` error is preserved. `render: "always"` explicitly requires the browser runtime and returns `CONFIG_MISSING` when it is unavailable. To avoid fetching twice, `always` does not inspect raw HTML before JavaScript executes; do not use it with secrets, authenticated state, Node.js bindings, or high-impact tools.

HTTP retrieval, browser queueing, navigation, extraction, and guards share one 15-second `read` deadline by default. Switching to the browser does not reset that deadline. Set `readTimeoutMs` to use another limit.

The browser process is reused, but every retrieval gets a new non-persistent BrowserContext. The default policy permits only GET and HEAD, and blocks other methods, subframes, popups, downloads, WebSockets, Service Workers, private-network destinations, and unnecessary image, media, and font requests. Rendered-page visibility checks run in an isolated world, and computed-hidden content is included in the guard scan.

Chromium's process sandbox is enabled by default. Use `externalSandbox: true` only when another container or sandbox provides equivalent isolation. Browser routing and the built-in DNS-pinning proxy are defense in depth, not an operating-system network sandbox. Add container or egress isolation when the host can reach sensitive networks.

## Model-facing tools

```ts
const toolset = web.toolset();

const responsesTools = toolset.openaiResponsesDefinitions();
const chatCompletionsTools = toolset.openaiChatCompletionsDefinitions();
const bedrockTools = toolset.bedrockDefinitions();

const output = await toolset.execute("web_search", {
  query: "Node.js HTTP security",
  limit: 5,
});
```

OpenAI and AWS SDKs are not runtime dependencies. Tool definitions are plain JSON objects.

`web_search` returns five results by default and bounds every external title and snippet. Results with high-severity injection patterns are withheld. `fetch_content` returns 5,000 visible characters by default and has a model-facing maximum of 20,000. Its output contains the citation URL, readable text, retrieval time, truncation state, and compact security metadata. It does not expose page HTML, scripts, styles, event attributes, hidden content, raw response metadata, or verbose guard diagnostics.

Every lower-level `SearchHit` and `searchAndRead().hits` entry is marked `trust: "untrusted"` and `tainted: true`. Titles and snippets remain external data; do not concatenate them into system instructions. Prefer `toolset()` when search output will be sent to a model. `openaiDefinitions()` remains a deprecated alias for the Chat Completions format.

## Context Guard

Every retrieved document is marked `trust: "untrusted"` and `tainted: true`, including documents with no findings. The built-in guard cannot be disabled.

The guard separates visible text, hidden content, comments, metadata, templates, and low-trust attributes. It performs bounded normalization of Unicode, zero-width characters, URL/hex escapes, Base64, delimiter splitting, and leetspeak. Segment head and tail samples are retained when a segment is too long; any omitted segment or character range makes the decision fail closed and is reported in `limitations`. HTTP charset, BOM, and HTML metadata use one decoder in both the client and standalone guard, with BOM taking precedence. Unsupported or invalid encodings return `UNSUPPORTED_CONTENT_ENCODING`.

Use the strict profile when selected medium-severity findings should be raised:

```ts
const web = createLlmFetch({
  search: duckDuckGo(),
  contextGuard: { profile: "strict" },
});
```

An organization-specific `ContentGuard` can be added but cannot replace the built-in guard. The stricter decision wins. Additional guards have a five-second deadline by default, configurable through `additionalGuardTimeoutMs`. Their returned strings, findings, and reasons are also size-bounded.

Context Guard is not proof that fetched text is safe. Core HTTP mode cannot evaluate visibility from external stylesheets, and browser mode cannot understand every semantic attack. Keep write tools, code execution, external sending, memory updates, and policy changes behind a separate application-level authorization step.

`fetcher` is an advanced testing/integration override. It replaces the SSRF-safe built-in HTTP transport. A production override owns destination-IP, DNS rebinding, redirect, response-size, content-type, and deadline enforcement. The client revalidates the returned URL shape and rejects obvious local or private literal destinations, but cannot prove which IP a custom transport contacted. Custom providers, retrievers, fetchers, and guards must honor the supplied `AbortSignal`; if they ignore it, the client can stop waiting but cannot stop their internal work.

## Error handling

```ts
import { LlmFetchError } from "llm-fetch";

try {
  await web.read({ url: "http://127.0.0.1/admin" });
} catch (error) {
  if (error instanceof LlmFetchError) {
    console.error(error.code, error.retryable, error.guardDecision);
  }
}
```

Built-in providers and transports do not include fetched HTML, search response bodies, cookies, or API keys in error messages. Custom implementations should preserve the same rule.

For `GUARD_DENIED`, `guardDecision` distinguishes `require_approval` from `deny`, and `warningCategories` contains only bounded category names. JSON serialization excludes the fetched body and error cause. See the [API and error reference](./docs/API.md) for defaults and recommended handling.

## Limitations and responsible use

HTML extraction does not include Shadow DOM, generated CSS content, canvas or image text, iframe bodies, or external stylesheet content. Only standard HTTP and HTTPS ports are accepted. Browser mode executes third-party JavaScript. Search queries are sent to the selected provider, while target sites receive network metadata such as the caller's IP, User-Agent, and access time. Review provider and site terms, robots guidance, access frequency, privacy, personal-data, and copyright obligations. See [Responsible use and privacy](./docs/RESPONSIBLE_USE.md).

`close()` is idempotent. Once closing begins, the client cannot be reused and new operations return `CONFIG_MISSING`.

## Development

```sh
npm install
npm run verify
npm pack --dry-run
```

For a local Brave provider canary, copy `.env.example` to `.env`, set
`BRAVE_SEARCH_API_KEY`, and run `npm run canary:brave`. The `.env` file is
ignored by Git and must never be committed. A successful canary logs only the
provider name and result count; a failure logs only the provider, failure
status, and typed error code. DuckDuckGo can be checked with
`npm run canary:duckduckgo` and does not require a secret.

Run the installed-Chromium integration test explicitly:

```sh
LLM_FETCH_PLAYWRIGHT_INTEGRATION=1 \
  npx vitest run test/playwright/integration.test.ts
```

`npm run verify` runs linting, type checks, unit/security tests, coverage gates, production-license checks, packed ESM/CommonJS/NodeNext/bundler consumers, `publint`, and Are The Types Wrong. The optional Chromium job runs separately in a non-root sandboxed container.

Maintainer release preparation and the one-time npm package-name bootstrap are documented in [the release runbook](./docs/RELEASE.md).

## License

`llm-fetch` is available under the [MIT License](./LICENSE). DuckDuckGo, Brave, Playwright, Chromium, and other external services or dependencies have their own terms and licenses.
