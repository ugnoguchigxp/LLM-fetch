import { bench, describe } from "vitest";
import {
  parseDuckDuckGoHtml,
  parseDuckDuckGoWeb,
} from "../src/providers/duckduckgo-parser.js";
import { extractHtmlContent, loadHtml } from "../src/retrieval/extract-content.js";
import { createInternalBuiltinContextGuard } from "../src/security/context-guard.js";

const results = Array.from(
  { length: 20 },
  (_, index) => `
    <div class="result">
      <a class="result__a" href="https://example.com/article-${index}">Result ${index}</a>
      <a class="result__url">example.com/article-${index}</a>
      <div class="result__snippet">A fixture result containing useful descriptive text.</div>
    </div>`,
).join("");
const duckHtml = `<html><body><div class="results">${results}</div></body></html>`;
const duckWeb = `DDG.pageLayout.load("d", ${JSON.stringify(
  Array.from({ length: 20 }, (_, index) => ({
    t: `Result ${index}`,
    a: "A <b>fixture</b> result containing useful descriptive text.",
    i: "example.com",
    u: `https://example.com/article-${index}`,
  })),
)});`;

const articleParagraph = `<p>${"A bounded TypeScript extraction paragraph with useful factual content. ".repeat(20)}</p>`;
const articleHtml = `<html><head><title>Large fixture</title></head><body><main>${articleParagraph.repeat(750)}</main></body></html>`;
const guard = createInternalBuiltinContextGuard();

describe("parsers", () => {
  bench("DuckDuckGo 20 results", () => {
    parseDuckDuckGoHtml(duckHtml, 20);
  });

  bench("DuckDuckGo signed Web 20 results", () => {
    parseDuckDuckGoWeb(duckWeb, 20);
  });

  bench("HTML extraction with shared guard DOM", () => {
    const $ = loadHtml(articleHtml);
    const prepared = guard.prepareHtml($, articleHtml);
    const extracted = extractHtmlContent($, "https://example.com/fixture", {
      maxCharacters: 20_000,
    });
    guard.inspectPrepared({
      visibleText: extracted.text,
      additionalSegments: prepared.segments,
      requestedUse: "answer_with_citation",
    });
  });
});
