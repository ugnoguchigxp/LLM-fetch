# Changelog

All notable changes to this project are documented here. Versions follow Semantic Versioning; release tags use the matching `v<version>` form.

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
