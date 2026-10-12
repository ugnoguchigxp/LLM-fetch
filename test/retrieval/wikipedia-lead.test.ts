import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { load } from "cheerio";
import { createLlmFetch, wikipedia } from "../../src/index.js";
import { loadHtml } from "../../src/retrieval/extract-content.js";
import { htmlToMarkdown } from "../../src/retrieval/html-to-markdown.js";
import { prepareHtmlForExtraction } from "../../src/security/html-segments.js";
const CONTACT = "https://github.com/ugnoguchigxp/LLM-fetch/issues";
const metadata = JSON.parse(
  readFileSync(new URL("../fixtures/wikipedia/metadata.json", import.meta.url), "utf8"),
) as Record<string, { url: string; hash: string; revid: number }>;
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/wikipedia/${name}-lead.json`, import.meta.url)));
describe("saved Wikipedia section 0 responses", () => {
  it.each(["soccer", "worldcup"])(
    "preserves every opening paragraph and all inspected material: %s",
    async (name) => {
      const body = fixture(name);
      expect(createHash("sha256").update(body).digest("hex")).toBe(metadata[name]!.hash);
      const json = JSON.parse(new TextDecoder().decode(body)) as { parse: { text: string } };
      const wiki = wikipedia({
        contact: CONTACT,
        fetcher: async (url) => ({
          requestedUrl: url,
          finalUrl: url,
          status: 200,
          contentType: "application/json",
          body,
          headers: {},
        }),
      });
      const client = createLlmFetch({ search: wiki, fetcher: wiki.fetcher });
      try {
        const document = await client.read({ url: metadata[name]!.url, maxCharacters: 8_000 });
        expect(document.security.decision).toBe("allow");
        expect(document.truncated).toBe(false);
        expect(document.characterCount).toBeLessThanOrEqual(8_000);
        expect(document.finalUrl).toContain(`oldid=${metadata[name]!.revid}`);
        expect(document.security.limitations).toContain(
          "Only Wikipedia section 0 was retrieved; later sections were not fetched or inspected.",
        );
        const diagnostics = document.security.diagnostics?.find((item) => item.stage === "content");
        expect(diagnostics?.scannedCharacters).toBe(diagnostics?.availableCharacters);
        expect(diagnostics?.omittedSegments).toBe(0);
        const $ = loadHtml(json.parse.text);
        prepareHtmlForExtraction($, json.parse.text);
        const paragraphs = $("p")
          .toArray()
          .filter((p) => $(p).text().trim());
        expect(paragraphs.length).toBeGreaterThanOrEqual(2);
        for (const paragraph of paragraphs)
          expect(document.text).toContain(htmlToMarkdown(paragraph, document.finalUrl));
        if (name === "soccer") {
          expect(document.text).toContain("|統括団体|国際サッカー連盟（FIFA）|");
          expect(document.text).toContain("|選手数|11人|");
        } else {
          expect(document.text).toMatch(/Column 1; header: チーム数\n\s+- Column 2: 48 （6連盟）/);
          expect(document.text).toMatch(/Column 1; header: 試合数\n\s+- Column 2: 104試合/);
        }
      } finally {
        await client.close();
      }
    },
  );
  it("maps a saved search response through client.search without inventing lead text", async () => {
    const body = new Uint8Array(
      readFileSync(new URL("../fixtures/wikipedia/soccer-search.json", import.meta.url)),
    );
    const wiki = wikipedia({
      contact: CONTACT,
      language: "ja",
      fetcher: async (url) => ({
        requestedUrl: url,
        finalUrl: url,
        status: 200,
        contentType: "application/json",
        body,
        headers: {},
      }),
    });
    const client = createLlmFetch({ search: wiki, fetcher: wiki.fetcher });
    try {
      const hits = await client.search({ query: "サッカー", limit: 1 });
      expect(hits[0]?.title).toBe("サッカー");
      expect(hits[0]?.url).toBe(metadata.soccer!.url);
      expect(load(hits[0]?.snippet ?? "")("span")).toHaveLength(0);
    } finally {
      await client.close();
    }
  });
});
