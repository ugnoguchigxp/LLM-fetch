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
| `contextGuard.maxSegments` | `128` | integer `1..4_096` |
| `contextGuard.maxCharacters` | `250_000` | integer `1..2_000_000` |
| `cache.enabled` | `true` | boolean |
| `cache.maxEntries` | `100` | integer `0..10_000` |
| `cache.searchTtlMs` | `30_000` | integer `0..86_400_000` |
| `cache.documentTtlMs` | `60_000` | integer `0..86_400_000` |
| `fetcher` | built-in safe HTTP | Advanced override; caller owns its network security boundary |
| `browser.defaultRender` | `auto` with a retriever, otherwise `never` | `never`, `auto`, or `always` |

`SafeHttpFetcherOptions` defaults to a 10-second transport deadline, 1,000,000 compressed bytes, 2,000,000 decoded bytes, and three redirects. It accepts only `text/html`, `application/xhtml+xml`, `text/plain`, `application/xml`, `text/xml`, and `text/markdown`; a client configuration cannot add a type that has no extractor. The media type is taken from `Content-Type`, not the URL extension. `text/markdown` is decoded with the same charset and BOM rules as other text types. HTML-free Markdown retains its structure and whitespace apart from LF normalization. A `<` also builds a separate inspection-only HTML projection; after guard approval, a separate formatter converts embedded HTML to Markdown while protecting code examples, escapes and autolinks. The projection inspects decoded values of all embedded HTML attributes, including attributes on hidden and removed elements, within the existing segment and character limits.

HTML and XHTML `text` is structured Markdown from the existing selected main content. Embedded HTML is also converted in Markdown responses. Heading levels, nested lists, fenced code and resolved HTTP(S)/mailto links are retained. Simple tables use pipe rows; merged, ragged or complex cells use explicit row/column records with spans and each source cell emitted once. There is no HTML fallback. Literal tags in code examples stay code data. Hidden/executable markup is omitted only from output, after the original material is guarded. HTML link destinations and the bounded class-derived code language used by generated fences are inspected too. `contentType` describes the source response; `characterCount` counts the formatted, untruncated text. Conversion is capped at 2,000,000 characters and 1,024 columns per table; exceeding either returns `RESPONSE_TOO_LARGE`. Existing return limits and `truncated` still apply. When cutting inside an originally closed inline code span, its terminator is kept within the limit so literal tags do not become markup. Code fences and links are not completed and may remain partial. No new format option or API is introduced.

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

| `GuardReasonCode` | Meaning |
| --- | --- |
| `PATTERN_DETECTED` | At least one finding other than `benign_mention`, including warnings |
| `SEGMENT_COUNT_LIMIT` | Scanner input exceeded `maxSegments` |
| `CHARACTER_BUDGET_LIMIT` | A selected segment still had unscanned characters after the character budget |
| `SEGMENT_TEXT_LIMIT` | A collector marked a segment `truncated` |
| `SEGMENT_COLLECTION_LIMIT` | The collector omitted at least one segment |
| `INSPECTION_INCOMPLETE` | Inspection was marked incomplete without one of the specific limit codes above |
| `ADDITIONAL_GUARD_RESTRICTION` | An additional guard returned `require_approval` or `deny` |

`CONTENT_INSUFFICIENT` may set `reasonCode` to `INSUFFICIENT_TEXT` or `DYNAMIC_RENDERING_REQUIRED`. Browser fallback in `auto` mode runs only for HTML or XHTML after a completed guard when one of those two reasons is present. Markdown, plain text, XML, `GUARD_DENIED`, and `GUARD_FAILED` do not start that fallback.

## Custom contracts

Custom providers, fetchers, retrievers, and guards must validate their own upstream responses, honor `AbortSignal`, return only bounded public metadata, and avoid secrets in errors. A custom fetcher owns DNS, address pinning, redirect validation, body limits, content-type checks, and its internal deadline. The client can validate its returned URL, but cannot verify the address that was actually contacted.
