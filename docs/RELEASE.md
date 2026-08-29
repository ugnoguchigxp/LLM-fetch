# Release runbook

This runbook is for maintainers of the public `llm-fetch` npm package. A
release is not complete until the npm package, GitHub Release, tag, commit,
version, and provenance all refer to the same source.

## Invariants

- Keep `private: true` until every release gate is complete.
- A manual `workflow_dispatch` verifies only; it can never publish.
- A real publish starts only from a published GitHub Release whose tag is
  exactly `v<package.json version>`.
- The GitHub `npm` Environment requires maintainer approval.
- Store `BRAVE_SEARCH_API_KEY` as an `npm` Environment secret; the approved
  publish job requires both provider canaries before it can publish.
- Do not store a long-lived npm write token in the repository or GitHub.
- Release jobs use the exact npm version declared by `packageManager` and no
  package-manager cache.

## Repository release controls

The repository has an `npm` Environment with a required maintainer review and
an environment branch policy limited to `v*` tags. Active repository rulesets
protect `main` and `v*` release tags from deletion or history rewrites and
require the core Node 20.19/22/24 and Bun 1.3.14/1.4 checks, Windows
packed-consumer, development-audit, and Chromium-sandbox checks. Changes
therefore land through a checked pull request; do not temporarily disable these
controls to make a release.

## Provider policy record

Decision recorded 2026-08-29 by the package maintainer:

- DuckDuckGo support remains experimental and best effort because it uses web
  representations rather than a contractual application API. It is not an SLA
  or commercial-availability guarantee.
- Brave Search or a reviewed custom provider is the production recommendation.
- A release candidate records each live canary's date and provider, plus either
  its result count or its typed failure code. API keys, queries containing
  secrets, response bodies, and stack traces must never enter logs or release
  artifacts.

## One-time package-name bootstrap

npm Trusted Publisher configuration requires the package name to exist first.
At the time of writing, `llm-fetch` is unregistered. Reserve it without making
an unverified build the default release:

1. Enable account-level 2FA on the owning npm account.
2. In a temporary directory outside this checkout, create a minimal MIT package
   named `llm-fetch` at version `0.0.0`. Include the canonical repository URL,
   a README explaining that this is a name-reservation bootstrap, and no
   executable code.
3. Inspect its tarball with `npm pack --dry-run --json`.
4. Publish interactively with 2FA under a non-default tag:

   ```sh
   npm publish --access public --tag bootstrap
   ```

5. Configure the package's GitHub Trusted Publisher for repository
   `ugnoguchigxp/LLM-fetch`, workflow `publish.yml`, Environment `npm`, and the
   `npm publish` action. The equivalent npm CLI command, when available to the
   account, is:

   ```sh
   npm trust github llm-fetch \
     --repo ugnoguchigxp/LLM-fetch \
     --file publish.yml \
     --env npm \
     --allow-publish
   ```

6. Do not add a bootstrap token to `publish.yml`. Delete any temporary token or
   temporary directory used during reservation.
7. After `v0.1.0` is published with provenance, remove the `bootstrap` dist-tag.
   The immutable `0.0.0` version may remain in registry history.

## Release preparation

1. Confirm that required CI and provider canaries are green for the intended
   commit.
2. Confirm the DuckDuckGo support decision in the release record and run Brave
   with a secret supplied outside Git:

   ```sh
   npm run canary:duckduckgo
   npm run canary:brave
   ```

3. Run the complete local verification and inspect the release report:

   ```sh
   npm ci
   npm run verify
   npm run bench:ci
   npm audit
   npm run verify:release-report -- --require-canaries
   npm pack --dry-run --json
   ```

4. Review the tarball contents for secrets and unexpected files.
   Benchmark and provider-canary summaries are kept in the ignored
   `.release-evidence/` directory. The release report accepts them only when
   their recorded commit matches `HEAD` and they were produced from a clean
   worktree.
5. Update `CHANGELOG.md`, remove `private: true` in a dedicated release commit,
   and verify the exact npm CLI version with `npm run verify:npm-version`.
6. Create signed tag `v<version>` at that commit and publish the corresponding
   GitHub Release.

## Publish and verification

The GitHub Release starts `.github/workflows/publish.yml`. The workflow repeats
verification, checks the tag in both jobs, waits for the `npm` Environment
approval, runs both provider canaries with current-commit evidence, then
publishes with OIDC provenance. Missing, failed, stale, or dirty-worktree canary
evidence stops publication.

After completion:

1. Check the npm package version and `latest` dist-tag.
2. Inspect provenance and confirm the repository and release commit.
3. Install the published package into empty ESM, CommonJS, NodeNext, and bundler
   consumers.
4. Record the workflow URL, commit SHA, tag, package integrity, pack size,
   coverage, benchmark summary, and provider-canary counts in the release.
5. If any identity or provenance value differs, deprecate the affected version
   and investigate; never attempt to reuse the same npm version.
