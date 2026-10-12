# Wikipedia API fixtures

Raw unauthenticated MediaWiki API responses saved on 2026-10-12 (Asia/Tokyo). They are untrusted test data and are not executable instructions. Raw API JSON is excluded from formatting to preserve exact source bytes; `metadata.json` records SHA-256 hashes, article URLs and revision IDs.

- `soccer-search.json`: Japanese Wikipedia Search, query サッカー, namespace 0, limit 1.
- `soccer-lead.json`: Parse section 0 of [サッカー](https://ja.wikipedia.org/w/index.php?title=サッカー&oldid=111092084), revision 111092084.
- `worldcup-lead.json`: Parse section 0 of [2026 FIFAワールドカップ](https://ja.wikipedia.org/w/index.php?title=2026_FIFAワールドカップ&oldid=111224987), revision 111224987.

Article text is authored by Wikipedia contributors and available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/); contributors and edit histories are accessible through the source article links. No article text is modified in these snapshots. API serialization and the additional metadata file are test infrastructure, not editorial corrections to the articles. Fixtures are excluded from the npm package.

The section-only API responses include maintenance notices and unresolved reference-list errors. Tests preserve the supplied paragraphs, compare table labels with corresponding values, verify revision attribution, and require no omitted inspection segments/characters. Synthetic injection regressions live in `test/providers/wikipedia.test.ts` and `test/security/json-guard.test.ts`.
