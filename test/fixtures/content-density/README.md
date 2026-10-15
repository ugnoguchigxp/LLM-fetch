# Content density fixtures

These public HTML responses were saved on 2026-10-12 at the user's explicit request for reproducible extraction tests. They are test data, never instructions or executable test code. Source URLs, file hashes, pre-change formatted lengths and hashes of the original guard material are in `baselines.json`. The original four baselines use the formatter from commit `73ebe0dfaff46634fbd7d9cbe69577a312da52fb`, the same content selector, and each original URL. The NPB baseline records the faulty link-density formatter before this correction (125 characters, missing both linked match records). No network access is required by the tests.

The raw `.html` snapshots are excluded from formatting so their hashes, original whitespace and malformed markup remain intact. This includes unmatched closing elements in the NASA response, which the HTML parser must handle as received.

- `tenki-daily.html`: Kamakura daily forecast, including today's and tomorrow's weather, high/low temperatures, four time-band precipitation probabilities, and the longer forecast table.
- `tenki-hourly.html`: Kamakura hourly forecast, including three days of 24 hourly values, merged date/period headers, graph cells, and direction/speed subrows.
- `nasa-news.html`: NASA Curiosity news article, with no tables. Tests retain every nonempty paragraph, including media contact information and the explicit source URL.
- `npb-results.html`: the 2026-10-11 Climax Series results list; two linked records contain Giants 1–4 DeNA at Tokyo Dome and Lions 0–1 Fighters at Belluna Dome, both second games. Match-record assertions check the original team/score/round/venue order.
- `wikipedia-paragraph.html`: Wikipedia's Paragraph article. Its prose is used for paragraph preservation; the page also contains maintenance and navigation tables.

`test/retrieval/content-density.test.ts` checks source hashes, unchanged visible/attribute/hidden inspection material, exact daily header/value pairs, all 72 hourly rows, both linked match records, output lengths, and article paragraph preservation. Renderer unit tests cover different element types, column-header splitting, expandable spans, complex-cell fallback, icon duplicates and bounded expansion.

The full pages exceed the former default scan limit of 128 segments. Following the segment-inspection change on 2026-10-12, these acceptance tests use default guard settings and verify complete inspection within the character budget. An hourly-forecast regression checks that every collected segment and character is inspected. Explicit count limits and actual collection or character-budget shortfalls remain fail closed.

Measured formatted character counts (without return truncation):

| Fixture             | Before |  After |  Acceptance limit |
| ------------------- | -----: | -----: | ----------------: |
| Daily forecast      |  8,862 |  2,928 |             4,000 |
| Hourly forecast     | 26,061 |  5,558 |             8,000 |
| NASA news           |  8,655 |  7,256 |       No increase |
| Wikipedia Paragraph | 34,033 | 18,922 |       No increase |
| NPB result list     |    125 |    215 | Keep both records |

Navigation omission follows the explicit HTML/ARIA contract (`nav` or `role="navigation"`). Unmarked link-only lists and cards keep their text without unnecessary URLs. This retains record values without guessing intent from sports words, numbers, domains or class/id names. The formatter correction increases daily/hourly output from 1,026/3,480 to 2,928/5,558 characters, still within their acceptance limits, while source hashes and guard material hashes remain identical.

## Inspection baseline update (2026-10-16)

The inspection hashes include title text as metadata, including when visible
selection fails and reviewed hidden content is recovered. Before updating the
hashes, all five fixtures were compared with the previous hashes after removing
only that newly added title segment; every previous inspection hash matched.
The saved HTML, visible text, existing segments, omitted counts and output-size
baselines remain unchanged.
