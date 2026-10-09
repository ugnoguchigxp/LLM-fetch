import { test } from "vitest";
import { parseDuckDuckGoHtml, parseDuckDuckGoWeb } from "../src/providers/duckduckgo-parser.js";
import { prepareRetrievedBody } from "../src/retrieval/prepare-retrieved.js";
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
const guard = createInternalBuiltinContextGuard({ maxCharacters: 2_000_000 });

test("parsers", async ({ bench }) => {
  await bench("DuckDuckGo 20 results", () => {
    parseDuckDuckGoHtml(duckHtml, 20);
  }).run();

  await bench("DuckDuckGo signed Web 20 results", () => {
    parseDuckDuckGoWeb(duckWeb, 20);
  }).run();

  await bench("HTML inspection and structured Markdown output", () => {
    const prepared = prepareRetrievedBody({
      decoded: articleHtml,
      contentType: "text/html",
      finalUrl: "https://example.com/fixture",
      fetchMethod: "http",
      maxCharacters: 20_000,
    });
    const result = guard.inspectPrepared({
      ...prepared,
      requestedUse: "answer_with_citation",
    });
    if (result.decision !== "allow") throw new Error("Benchmark fixture was withheld.");
    if (prepared.pendingError) throw prepared.pendingError;
    if (!prepared.extract) throw new Error("Benchmark fixture has no extractor.");
    prepared.extract();
  }).run();
});
