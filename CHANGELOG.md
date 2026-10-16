# Changelog

All notable changes to this project are documented here. Versions follow Semantic Versioning; release tags use the matching `v<version>` form.

## 0.1.4 - 2026-10-16

- Inspect HTML title metadata in the shared collector before either visible extraction or reviewed hidden-material recovery, so an attack title cannot bypass the guard when visible selection fails.
- Added opt-in, host-supplied semantic assessment of complete inspected reference material. The original request/reference detection is retained, including indirect cross-sentence requests. Without an assessor the built-in decision is final; incomplete inspection, failed/invalid assessment and additional-guard restrictions cannot be cleared. Assessment input and time are bounded and document content remains untrusted.
- When visible HTML extraction is insufficient, a successful complete semantic assessment can authorize extraction of the same response's reviewed reference material, including hidden server-rendered content. Scripts remain excluded, return limits and taint are preserved, and security limitations record the extraction mode. No site or framework exception is added.
- Honor an explicitly configured guard character budget during HTML, embedded-HTML Markdown and JSON segment collection, instead of discarding the middle of every segment longer than 64,000 characters. Default collection ceilings, aggregate scan limits, return limits, taint and fail-closed policy are preserved.
- Removed the unmaintained Tauri/Rust plugin, example, Cargo workspace, Rust fixture export and dedicated verification jobs. Maintenance now covers the TypeScript npm package and optional Playwright extension. TypeScript guard inspection, detection, tests and runtime behavior are unchanged; the source-file size check remains in Node CI.

## 0.1.3 - 2026-10-12

- Added opt-in `wikipedia({ contact, language })` search and its section-0 `fetcher`, using Wikimedia API contracts and a contact-bearing bot User-Agent. Opening sections return Markdown and revision-specific citation URLs; ordinary reads and provider routing keep their defaults.
- Retain adapter source JSON for inspection: decode all keys/values and HTML projections, inspect unmapped fields within the shared read budget, and send exact JSON plus generated HTML to additional guards. Collection limits, detection rules and guard decision policy are unchanged.
- Scan all collected segments within the character budget by default, so pages with many short attributes are not withheld solely for exceeding 128 fragments. Explicit `maxSegments` limits and actual collection or character-budget shortfalls still fail closed. Diagnostic `maxSegments: 0` indicates that no scan count limit was configured.
- Increased information density in HTML/XHTML and embedded-HTML Markdown output without changing content-candidate selection or guard inspection. Expand simple merged cells into pipe tables, transpose wide row-header matrices or split tables to at most 12 columns, and keep row/column records for complex cells. Wide full-row values are retained once as labeled table context.
- Preserve text in ambiguous link-heavy blocks so linked records (including match cards) are not mistaken for navigation. Omit `nav` and explicitly marked `role="navigation"` elements during formatting, keep standalone link labels without URLs, and retain resolved URLs in prose references. No site/class/id dictionaries or content classifiers are added. Candidate selection, guard inspection material, detection rules, limits and decision policy are unchanged.
- Deduplicate icon alt text immediately repeated by displayed text. Public API types and return limits are unchanged.
- Fixed unrelated words on financial and news pages triggering instruction-override or source-suppression findings. These rules now require a direct request and an associated instruction or citation target, without guessing references across sentences or paragraphs. TypeScript and Rust share regression fixtures; inspection limits and decision policy are unchanged.
- Preserve detection of word-delimited directives such as `ignore.previous instructions` through inspection-only normalization. Returned document text is unchanged.

## 0.1.2 - 2026-10-09

- Added `text/markdown` retrieval with structured Markdown output. A `<` also triggers a separate HTML inspection projection; returned text remains untrusted reference data.
- Fixed character-budget allocation so selected segments are scanned in full when their combined length is within the configured limit. Segment and character caps are unchanged, and a real shortfall still fails closed.
- Added `reasonCodes` and bounded numeric `diagnostics` to built-in guard results. `GUARD_DENIED` carries the same codes. `toJSON()` omits diagnostics. `CONTENT_INSUFFICIENT` may include `INSUFFICIENT_TEXT` or `DYNAMIC_RENDERING_REQUIRED`.
- Inspect selected text before applying the return-length limit. Attacks beyond `maxCharacters` are no longer ignored, so some previously returned documents can now be `GUARD_DENIED`. Documents that were withheld only by the old per-segment share can now be allowed when the total still fits.

- Inspect decoded values of every HTML attribute embedded in Markdown, including attributes on hidden and removed elements, while preserving the existing collection and scan limits.
- Report `DYNAMIC_RENDERING_REQUIRED` for empty and very short JavaScript app shells after the guard completes.
- Return HTML/XHTML and embedded HTML in Markdown as structured Markdown after guard approval. Preserve heading levels, nested lists, code and links; use pipe tables for simple cells and row/column records for merged or complex cells. Do not retain HTML elements or fall back to HTML. Literal tags in code remain code data.
- Inspect HTML link destinations before formatting. Keep the original guard material, inspection caps and fail-closed behavior; bound formatted output and table width without new runtime dependencies.
- Fixed Markdown code detection across paragraph, quote, list and table boundaries. Keep literal tags and empty lines inside code, preserve code blocks in complex table cells, and stop row spans at their row group.
- Preserve linked headings and block content, quoted prose and all-space code examples. Keep an original inline-code terminator within the return limit when truncating; do not close code fences or links.
- Inspect the bounded class-derived code language that enters generated fences. Removed the unused plain HTML return wrapper and guard preparation method; align model tool descriptions and parser benchmarks with structured Markdown output.
- Updated locked transitive dependencies `undici` to 7.30.0 and `source-map-js` to 1.2.2 to resolve the dependency-audit findings without adding runtime dependencies.
- Corrected the documented minimum Node.js version to match the existing 22.18 package requirement.

## 0.1.1 - 2026-09-13

- Fixed technical descriptions being withheld by the built-in TypeScript and Rust guards due to unrelated memory/store, function/run, and token/output words. Tool, secret, external-send, memory, and policy rules now require request evidence and an associated target; explicit references can connect requests across sentences.
- Kept direct override detection, hidden/attribute inspection, normalization, requested-use policy, and inspection-limit handling. No new dependencies or external classifiers are used.
- Added rule identifiers and normalized variant UTF-16 evidence ranges to built-in finding reasons without returning matched text or changing public types. Reason strings are diagnostic text, not a stable parsing API.
- Added technical-document regression fixtures and real HTTP/Chromium retrieval checks; the packed-consumer verification now runs the guard retrieval E2E.

- Fixed release evidence generation for Vitest 5 by reading its JSON report from an explicit temporary output file.

- Updated the TypeScript toolchain to TypeScript 7, Oxlint/Oxfmt, tsdown, and Vitest 5.
- Updated npm and Cargo dependencies, Playwright CI, and Dependabot security coverage.
- Raised the minimum supported Node.js version to 22.18.

## 0.1.0 - 2026-08-29

- Added bounded HTTP and optional Playwright content retrieval for public web pages.
- Added DuckDuckGo best-effort search, Brave Search, and custom provider contracts.
- Added a fail-closed Context Guard with structured taint, findings, limitations, and approval decisions.
- Added ESM, CommonJS, NodeNext, bundler, OpenAI Responses, OpenAI Chat Completions, and Amazon Bedrock compatibility checks.
- Added release coverage, package, type, license, performance, and Chromium sandbox verification workflows.
- Fixed extraction when a short candidate precedes longer body-only content.
- Declared and tested Node.js 20.19 as the exact minimum supported Node release.
- Made release provider canaries mandatory and expanded the independent Context Guard corpus.
