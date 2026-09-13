# Changelog

All notable changes to this project are documented here. Versions follow Semantic Versioning; release tags use the matching `v<version>` form.

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
