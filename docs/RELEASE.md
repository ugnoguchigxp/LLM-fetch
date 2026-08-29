# Release runbook

This runbook is for maintainers of the public `llm-fetch` npm package. npm
publication is an explicit local operation. No GitHub Actions workflow publishes
the package.

## Invariants

- Keep `private: true` until the release commit is ready to publish.
- Publish only from a clean checkout of the reviewed release commit.
- Use the npm account's interactive authentication and 2FA requirements.
- Keep `BRAVE_SEARCH_API_KEY` in the local `.env` file. Do not commit it or copy
  it to GitHub for npm publication.
- Never place npm credentials or provider API keys in repository files, logs, or
  release artifacts.
- Do not automate `npm publish` without a separate maintainer decision.

## Provider policy

- DuckDuckGo support is experimental and best effort because it uses web
  representations rather than a contractual application API.
- Brave Search or a reviewed custom provider is the production recommendation.
- A release candidate records each live canary's date and provider, plus either
  its result count or typed failure code. API keys, response bodies, and stack
  traces must not enter the record.
- Brave must pass before publication. A typed DuckDuckGo challenge may proceed
  to maintainer review because that provider is experimental.

## Prepare the release

1. Confirm that the required CI checks are green for the intended commit.
2. From a clean local checkout, run the provider canaries. The Brave command
   reads `BRAVE_SEARCH_API_KEY` from the ignored `.env` file:

   ```sh
   npm run canary:duckduckgo
   npm run canary:brave
   ```

3. Run the complete verification and inspect the package contents:

   ```sh
   npm ci
   npm run verify
   npm run bench:ci
   npm audit
   npm run verify:release-report -- --require-canaries
   npm pack --dry-run --json
   ```

4. Review the tarball contents for secrets and unexpected files. Canary and
   benchmark summaries stay in the ignored `.release-evidence/` directory and
   must refer to the current clean commit.
5. Update `CHANGELOG.md` and the version if necessary. Remove `private: true`
   in the dedicated release commit, then repeat the verification commands.
6. Create a signed local tag named `v<package.json version>` at that exact
   commit.

## Publish manually

Authenticate interactively and publish from the repository root:

```sh
npm login
npm whoami
npm publish --access public
```

`prepublishOnly` reruns the repository verification before npm accepts the
package. Complete any npm 2FA prompt directly; do not store its credentials in
GitHub.

## Verify and announce

1. Confirm the published version and `latest` tag with `npm view llm-fetch`.
2. Install the published version in empty ESM, CommonJS, NodeNext, and bundler
   consumers.
3. Record the commit SHA, tag, npm integrity, pack size, coverage, benchmark,
   and provider-canary results in the release notes.
4. Push the release commit and signed tag, then create the matching GitHub
   Release.
5. If package identity or contents are wrong, deprecate the affected version
   and publish a corrected new version. npm versions are immutable and must not
   be reused.
