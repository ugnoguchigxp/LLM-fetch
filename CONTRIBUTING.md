# Contributing

Use Node.js 22.18 or later and the npm version declared in `packageManager`.

```sh
npm ci
npm run verify
npm run bench:ci
```

The 1 MiB HTML extraction-and-guard fixture has a 150 ms budget, including Markdown output. The CI gate uses the median p95 from three isolated processes and also fails when at least two processes exceed the budget. This regression budget accommodates shared-runner variability; it is not a latency guarantee for live pages. Guard inspection limits are independent of this timing budget.

Changes to retrieval, parsing, browser boundaries, or Context Guard behavior need a focused regression test. Security-limit changes must remain fail closed and include a reason for any threshold adjustment. Do not add OpenAI, AWS, or Playwright SDKs as core runtime dependencies.

Keep pull requests focused. Record externally observable API changes in `CHANGELOG.md`. Never include fetched bodies, private URLs, API keys, cookies, or other secrets in fixtures, logs, issues, or error messages.

Releases are maintainer-only and are published explicitly from a verified local checkout with `npm publish --access public`. No GitHub Actions workflow publishes this package.
