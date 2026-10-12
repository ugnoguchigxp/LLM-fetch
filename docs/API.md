# API and error reference

The public TypeScript declarations are authoritative. This page collects defaults and operational handling in one place.

## Client options

| Option | Default | Valid range or contract |
| --- | ---: | --- |
| `search` | omitted | `SearchProvider`; required only by search operations |
| `searchTimeoutMs` | `10_000` | integer `1..300_000` |
| `readTimeoutMs` | `15_000` | integer `1..300_000` |
| `searchAndReadTimeoutMs` | `15_000` | integer `1..300_000` |
| `additionalGuardTimeoutMs` | `5_000` | integer `1..300_000` |
| `contextGuard.profile` | `balanced` | `balanced` or `strict` |
| `contextGuard.maxSegments` | omitted | optional hard count limit, integer `1..4_096`; by default all collected segments share the character budget |
| `contextGuard.maxCharacters` | `250_000` | integer `1..2_000_000` |
| `cache.enabled` | `true` | boolean |
| `cache.maxEntries` | `100` | integer `0..10_000` |
| `cache.searchTtlMs` | `30_000` | integer `0..86_400_000` |
| `cache.documentTtlMs` | `60_000` | integer `0..86_400_000` |
| `fetcher` | built-in safe HTTP | Advanced override; caller owns its network security boundary |
| `browser.defaultRender` | `auto` with a retriever, otherwise `never` | `never`, `auto`, or `always` |

`SafeHttpFetcherOptions` defaults to a 10-second transport deadline, 1,000,000 compressed bytes, 2,000,000 decoded bytes, and three redirects. It accepts only `text/html`, `application/xhtml+xml`, `text/plain`, `application/xml`, `text/xml`, and `text/markdown`; a client configuration cannot add a type that has no extractor. The media type is taken from `Content-Type`, not the URL extension. `text/markdown` is decoded with the same charset and BOM rules as other text types. HTML-free Markdown retains its structure and whitespace apart from LF normalization. A `<` also builds a separate inspection-only HTML projection; after guard approval, a separate formatter converts embedded HTML to Markdown while protecting code examples, escapes and autolinks. The projection inspects decoded values of all embedded HTML attributes, including attributes on hidden and removed elements, within the existing segment and character limits.

HTML and XHTML `text` is structured Markdown from the existing selected main content. Embedded HTML is also converted in Markdown responses. Heading levels, nested lists and fenced code are retained. Simple tables, including paragraph cells and expandable row/column spans, use pipe rows; ragged rows are padded with empty cells. Tables wider than 12 columns are transposed when their row headers provide the correspondence, or split with the first column repeated in each part. Full-width values in wide tables are retained once as labeled table context. Nested tables, code blocks, lists and block quotes in cells use explicit row/column records, with each source cell emitted once. There is no HTML fallback. Literal tags in code examples stay code data.

Formatting excludes `nav` elements and elements explicitly marked `role="navigation"` (case-insensitive, with surrounding whitespace ignored). Other link-heavy blocks retain their text, including nested linked records: link density alone cannot distinguish navigation from useful information. Standalone links retain labels; resolved HTTP(S)/mailto URLs are retained in prose paragraphs or list items with less than 50% linked text and at least 20 non-link characters. These structural rules do not classify link intent or inspect domain/class/id names. Text counts for link density exclude whitespace and include image alt text. An icon's alt text is omitted when the following displayed text repeats the same label, including matching icon-only subrows under a shared table header. Repeated table values are preserved. Filtering happens only after guard approval: removed navigation and omitted link destinations remain in the original inspection material.

`contentType` describes the source response; `characterCount` counts the formatted, untruncated text. Conversion is capped at 2,000,000 characters, 1,024 source columns per table and 1,000,000 expanded grid slots per table; exceeding a limit returns `RESPONSE_TOO_LARGE`. Existing return limits and `truncated` still apply. When cutting inside an originally closed inline code span, its terminator is kept within the limit so literal tags do not become markup. Code fences and links are not completed and may remain partial. No new format option or API is introduced.

## Transport and provider options

### `SafeHttpFetcherOptions`

| Option | Default | Valid range or contract |
| --- | ---: | --- |
| `timeoutMs` | `10_000` | integer `1..300_000` |
| `maxWireBytes` | `1_000_000` | integer `1..10_000_000` |
| `maxDecodedBytes` | `2_000_000` | integer `1..10_000_000` |
| `maxRedirects` | `3` | integer `0..10` |
| `userAgent` | package name and version | non-empty, at most 512 characters, no control characters |
| `resolver` | Node.js DNS lookup | `AddressResolver`; every returned address is revalidated |
| `allowedContentTypes` | six readable media types | non-empty array; the client accepts only types it can extract |

Only standard HTTP port 80 and HTTPS port 443 are accepted. The wire limit applies before decompression and the decoded limit applies after gzip, deflate, or Brotli decoding.

### Search providers

| Provider option | Default | Valid range or contract |
| --- | ---: | --- |
| `BraveOptions.apiKey` | required | trimmed non-empty string, at most 512 characters, no control characters |
| `BraveOptions.timeoutMs` | `5_000` | integer `1..300_000` |
| `BraveOptions.maxResponseBytes` | `1_000_000` | integer `1..10_000_000` |
| `BraveOptions.fetch` | `globalThis.fetch` | Fetch-compatible function |
| `DuckDuckGoOptions.timeoutMs` | `4_000` | integer `1..300_000` |
| `DuckDuckGoOptions.maxResponseBytes` | `750_000` | integer `1..10_000_000` |
| `DuckDuckGoOptions.userAgent` | bounded browser-like value | non-empty, at most 512 characters, no control characters |
| `DuckDuckGoOptions.fetch` | `globalThis.fetch` | Fetch-compatible function |

Brave requires an explicit API key and keeps a process-local `Retry-After` cooldown. DuckDuckGo is experimental and keeps a process-local cooldown after rate limits or bot challenges; it does not solve challenges or rotate proxies.

### `PlaywrightRetrieverOptions`

| Option | Default | Valid range or contract |
| --- | ---: | --- |
| `concurrency` | `2` | integer `1..8` |
| `maxQueue` | `32` | integer `0..1_000` |
| `navigationTimeoutMs` | `8_000` | integer `100..60_000` |
| `settleTimeoutMs` | `750` | integer `0..5_000` |
| `maxRequests` | `100` | integer `1..1_000` |
| `maxResponseBytes` | `5_000_000` | integer `100_000..50_000_000` |
| `maxHtmlCharacters` | `2_000_000` | integer `10_000..10_000_000` |
| `maxDomNodes` | `100_000` | integer `100..500_000`; elements, text, and comments count |
| `dnsCacheTtlMs` | `1_000` | integer `0..10_000` |
| `resolver` | Node.js DNS lookup | `AddressResolver`; the pinned proxy revalidates every destination |
| `externalSandbox` | `false` | boolean; `true` delegates Chromium process isolation to the deployment |
| `userAgent` | package name and version | non-empty, at most 512 characters, no control characters |

`maxResponseBytes` bounds the rendered HTML bytes and total observed browser network traffic. The retriever also creates a fresh context, allows only GET and HEAD, and blocks subframes, WebSockets, Service Workers, downloads, popups, and browser permissions. See `SECURITY.md` for the remaining browser boundary limitations.

## Operation input

| Field | Default | Range or format |
| --- | ---: | --- |
| `query` | required | `1..400` trimmed characters |
| `limit` | `10` (`5` in the model tool) | integer `1..20` |
| `safeSearch` | `moderate` | `strict`, `moderate`, or `off` |
| `timeRange` | omitted | `day`, `week`, `month`, or `year` |
| `language` | omitted | ISO 639-1, two letters |
| `region` | omitted | ISO 3166-1 alpha-2, two letters |
| `locale` | omitted | Deprecated provider-specific string; cannot be combined with `language` or `region` |
| `maxCharacters` | `20_000` | integer `200..100_000` (`fetch_content`: default `5_000`, maximum `20_000`) |
| `maxCharactersPerDocument` | `20_000` | integer `200..100_000` |
| `concurrency` | `4` | integer `1..16` |
| `perHostConcurrency` | `min(2, concurrency)` | integer `1..concurrency` |
| `render` | client default | `never`, `auto`, or `always` |
| `requestedUse` | `answer_with_citation` | `summarize`, `answer_with_citation`, `extract_facts`, `search_more`, or `call_readonly_tool` |
| `signal` | omitted | `AbortSignal`; caller abort rejects rather than returning partial results |

`SearchHit` and `searchAndRead().hits` always carry `trust: "untrusted"` and `tainted: true`. When an overall read deadline expires, `SearchAndReadResult.timedOut` is true and failure kinds distinguish `overall_timeout`, `not_started`, `page_timeout`, and `page_failure`. A caller abort rejects rather than returning a partial result.

## Tool definitions

- `openaiResponsesDefinitions()` returns flat Responses API function tools with strict schemas.
- `openaiChatCompletionsDefinitions()` returns Chat Completions wrappers with strict schemas.
- OpenAI strict schemas mark every property as required; nullable values such as `limit: null` or `maxCharacters: null` select the documented defaults.
- `openaiDefinitions()` is a deprecated alias for the Chat Completions format.
- `bedrockDefinitions()` returns Converse API `toolSpec` objects.

SDK packages are development-only compatibility dependencies and are not installed by `llm-fetch` consumers.

## Errors

| Code | Retryable in typical cases | Recommended handling |
| --- | --- | --- |
| `INVALID_INPUT` | no | Fix input or configuration; do not retry unchanged |
| `CONFIG_MISSING` | no | Configure the requested provider or browser runtime |
| `UNSAFE_URL` | no, except transient DNS failures may be retryable | Reject the destination; never bypass SSRF checks automatically |
| `TIMEOUT` | yes | Retry with bounded backoff or retain partial `searchAndRead` results |
| `RATE_LIMITED` | yes | Wait at least `cooldownMs`; cooldown state is process-local |
| `BOT_CHALLENGE` | yes | Stop automated retries until `cooldownMs` or use an approved provider |
| `UPSTREAM_HTTP` | depends on status | Retry only when `retryable` is true |
| `PARSE_CHANGED` | usually yes | Treat as a provider compatibility failure, not an empty result |
| `RESPONSE_TOO_LARGE` | no | Reduce the source or configured size; inspection does not continue |
| `UNSUPPORTED_CONTENT_TYPE` | no | Use a supported extractor or reject the source |
| `UNSUPPORTED_CONTENT_ENCODING` | no | Correct the declaration or reject the source; no silent UTF-8 fallback occurs |
| `CONTENT_INSUFFICIENT` | no | Use browser fallback when appropriate or select another source |
| `GUARD_FAILED` | no | Withhold content; repair the additional guard |
| `GUARD_DENIED` | no | Route `guardDecision: "require_approval"` to a human approval flow; reject `deny` |
| `UNKNOWN` | no by default | Log bounded metadata and investigate |

`LlmFetchError.toJSON()` exposes only bounded metadata. It never serializes `cause`, `guardDiagnostics`, response bodies, hidden text, cookies, or API keys. Host code that needs the numeric scan summary reads `error.guardDiagnostics` explicitly and does not forward it to a model.

`RetrievedDocument.truncated` means only that the returned `text` was shortened. `characterCount` is the selected text length before that return limit. Inspection uses the selected text before the return limit is applied, so a smaller `maxCharacters` does not hide the tail from the guard. An inspection shortfall fails closed even when the returned slice would have been harmless.

Built-in guard results always include `reasonCodes`. `diagnostics` contains one bounded record per inspection. Merged results keep at most eight records, in inspection order. Those eight records are the first summaries, not a document-wide total. Counts are non-negative safe integers of UTF-16 code units. They do not include URLs, hashes, or matched text.

The default guard scans every collected segment when their total fits `maxCharacters`, preserving individual attribute, comment, hidden-text and visible-text boundaries. It does not discard the middle of a page because it contains many short attributes. The existing character allocation applies across all segments when the total exceeds the budget, and any uninspected text still requires approval or denies tool chaining. HTML collection retains its separate 4,097-segment and 64,000-character per-segment limits; omitted or truncated collection material still fails closed. An explicitly configured `maxSegments` retains its hard count limit and head/tail selection. Diagnostic `maxSegments: 0` means no separate scan count limit; `selectedSegmentCount` may therefore exceed 128. Configuration value `0` remains invalid.

| `GuardReasonCode` | Meaning |
| --- | --- |
| `PATTERN_DETECTED` | At least one finding other than `benign_mention`, including warnings |
| `SEGMENT_COUNT_LIMIT` | Scanner input exceeded an explicitly configured `maxSegments` |
| `CHARACTER_BUDGET_LIMIT` | A selected segment still had unscanned characters after the character budget |
| `SEGMENT_TEXT_LIMIT` | A collector marked a segment `truncated` |
| `SEGMENT_COLLECTION_LIMIT` | The collector omitted at least one segment |
| `INSPECTION_INCOMPLETE` | Inspection was marked incomplete without one of the specific limit codes above |
| `ADDITIONAL_GUARD_RESTRICTION` | An additional guard returned `require_approval` or `deny` |

`CONTENT_INSUFFICIENT` may set `reasonCode` to `INSUFFICIENT_TEXT` or `DYNAMIC_RENDERING_REQUIRED`. Browser fallback in `auto` mode runs only for HTML or XHTML after a completed guard when one of those two reasons is present. Markdown, plain text, XML, `GUARD_DENIED`, and `GUARD_FAILED` do not start that fallback.

## Custom contracts

Custom providers, fetchers, retrievers, and guards must validate their own upstream responses, honor `AbortSignal`, return only bounded public metadata, and avoid secrets in errors. A custom fetcher owns DNS, address pinning, redirect validation, body limits, content-type checks, and its internal deadline. The client can validate its returned URL, but cannot verify the address that was actually contacted.

## Wikipedia search and opening sections

`wikipedia({ contact, language })` returns a `WikipediaProvider`: a standard `SearchProvider` with a `fetcher` for section 0 retrieval. Opt in to both parts:

```ts
import { createLlmFetch, wikipedia } from "llm-fetch";

const wiki = wikipedia({
  contact: "https://your-app.example/contact", // Your public contact URL or email
  language: "ja",
});
const client = createLlmFetch({ search: wiki, fetcher: wiki.fetcher });
try {
  const result = await client.searchAndRead({
    query: "サッカー",
    limit: 1,
    maxCharactersPerDocument: 8_000,
  });
  // Or read a known article without searching:
  const article = await client.read({ url: "https://ja.wikipedia.org/wiki/サッカー" });
} finally {
  await client.close();
}
```

| Option | Default | Contract |
| --- | --- | --- |
| `contact` | required | Public HTTP(S) contact URL or email; no whitespace, control characters or parentheses; at most 400 characters |
| `language` | `en` | Wikipedia language edition; `SearchInput.language` overrides it for searches |
| `retrieval` | safe HTTP defaults | Transport limits, resolver and timeout; User-Agent and content types are controlled by the adapter |
| `contextGuard` | built-in defaults | Guard settings for the complete search API response; client guard settings separately govern reads |
| `fetcher` | safe HTTP transport | Advanced trusted override; caller owns network safety and the contact-bearing User-Agent |

The adapter sends `llm-fetch-wikipedia-bot/<version> (<contact>)`, serializes API requests per provider instance, and never impersonates a browser or solves a challenge. It uses [MediaWiki Search](https://www.mediawiki.org/wiki/API:Search) in article namespace 0 and [Parse](https://www.mediawiki.org/wiki/API:Parsing_wikitext) with `section=0`. `timeRange`, `region`, and explicit SafeSearch filtering other than `off` are unsupported and rejected instead of silently ignored. No keyword-based routing is added; the application or LLM selects the provider.

The fetcher handles HTTPS article URLs on language editions of `wikipedia.org` (`/wiki/<title>` and `/w/index.php?title=...`). Explicit `oldid` revisions are preserved. Other URLs retain normal HTTP retrieval. Using only `search: wiki` keeps ordinary full-page reads; use `fetcher: wiki.fetcher` for opening sections. Rendering is unnecessary; choose `render: "never"` when a browser retriever is also configured.

`read()` and `searchAndRead()` return the complete fetched opening section as Markdown, including its tables, subject to the existing return limit. `url` is the requested article URL; `finalUrl` identifies the returned revision through `oldid`. `contentType` is `text/html`, the adapter's HTML representation. `security.limitations` explicitly records that later sections were not fetched or inspected. Maintenance notices and API-generated citation errors can appear in section 0 and are preserved; snippets are search matches, not substitutes for the opening text.

Before mapping search hits, the built-in guard inspects every key/value of the API response after JSON decoding, including unmapped fields and HTML projections. For reads the exact JSON is retained as `SafeFetchResult.originalResponse`; the client inspects it alongside the HTML within one character budget and the existing collection ceiling. Additional guards receive both the generated HTML and the exact original JSON; their decisions are merged with the built-in decision. Unicode-escaped directives, hidden markup, comments, metadata, templates and decoded attributes remain inspection material. A capacity shortfall still blocks retrieval. JSON parsing adds no new instruction patterns or weaker decision policy. Ordinary client defaults and accepted document content types remain unchanged.

Follow Wikimedia's [User-Agent policy](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy) and [API etiquette](https://www.mediawiki.org/wiki/API:Etiquette). Rate limits produce `RATE_LIMITED`, malformed schemas produce `PARSE_CHANGED`, and guard refusals produce `GUARD_DENIED`; this adapter does not automatically retry failed requests. Cache reuse and rate-limit scheduling remain the application's responsibility.
