# Contributing

Use Node.js 20.19, 22, or 24 and the npm version declared in `packageManager`.

```sh
npm ci
npm run verify
npm run bench:ci
```

Changes to retrieval, parsing, browser boundaries, or Context Guard behavior need a focused regression test. Security-limit changes must remain fail closed and include a reason for any threshold adjustment. Do not add OpenAI, AWS, or Playwright SDKs as core runtime dependencies.

Keep pull requests focused. Record externally observable API changes in `CHANGELOG.md`. Never include fetched bodies, private URLs, API keys, cookies, or other secrets in fixtures, logs, issues, or error messages.

Releases require all protected-branch checks, a package/version-matching tag, the npm environment approval, and provenance through the repository publish workflow. Do not publish from a developer workstation.
