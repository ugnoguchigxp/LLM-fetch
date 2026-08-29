import { describe, expect, it } from "vitest";
import {
  decodeBody,
  extractHtmlContent,
  extractPlainTextContent,
  loadHtml,
  loadXml,
} from "../../src/retrieval/extract-content.js";

function utf16Be(value: string): Uint8Array {
  const bytes = new Uint8Array(2 + value.length * 2);
  bytes.set([0xfe, 0xff]);
  for (const [index, character] of [...value].entries()) {
    const code = character.charCodeAt(0);
    bytes[2 + index * 2] = code >> 8;
    bytes[3 + index * 2] = code & 0xff;
  }
  return bytes;
}

describe("bounded extraction decoding", () => {
  it("gives a BOM precedence over a conflicting HTTP declaration", () => {
    expect(decodeBody(utf16Be("hello"), "text/plain; charset=utf-8")).toBe(
      "hello",
    );
  });

  it("uses an HTML meta charset when the HTTP header omits one", () => {
    const html = '<meta charset="utf-8"><main>日本語の本文</main>';
    expect(decodeBody(new TextEncoder().encode(html), "text/html")).toBe(html);
  });

  it("does not treat data attributes as charset declarations", () => {
    const html = '<meta data-charset="shift_jis"><main>日本語の本文</main>';
    expect(
      decodeBody(
        new TextEncoder().encode(html),
        "text/html; xcharset=shift_jis",
      ),
    ).toBe(html);
  });

  it("recognizes UTF-8, UTF-16LE, Shift_JIS aliases, and http-equiv metadata", () => {
    expect(
      decodeBody(
        new Uint8Array([0xef, 0xbb, 0xbf, 0x6f, 0x6b]),
        "text/plain",
      ),
    ).toBe("ok");
    expect(
      decodeBody(new Uint8Array([0xff, 0xfe, 0x6f, 0x00, 0x6b, 0x00]), "text/plain"),
    ).toBe("ok");
    expect(decodeBody(new TextEncoder().encode("ascii"), "text/plain; charset=sjis")).toBe(
      "ascii",
    );
    const html =
      '<meta http-equiv="content-type" content="text/html; charset=utf-8"><p>本文</p>';
    expect(decodeBody(new TextEncoder().encode(html), "text/html")).toBe(html);
  });

  it("rejects invalid bytes for a declared encoding", () => {
    expect(() =>
      decodeBody(new Uint8Array([0xff]), "text/plain; charset=utf-8"),
    ).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_CONTENT_ENCODING" }),
    );
  });

  it("rejects deeply nested HTML before recursive parser consumers run", () => {
    const html = `${"<div>".repeat(1_001)}content${"</div>".repeat(1_001)}`;
    expect(() => loadHtml(html)).toThrowError(
      expect.objectContaining({ code: "RESPONSE_TOO_LARGE" }),
    );
    expect(() => loadHtml("<div/>".repeat(600))).toThrowError(
      expect.objectContaining({ code: "RESPONSE_TOO_LARGE" }),
    );
  });

  it("does not count markup-like text inside HTML text elements as nested tags", () => {
    const html = `<html><head><title>${"<div>".repeat(600)}</title></head><body>
      <textarea>${"<section>".repeat(600)}</textarea>
      <main>${"Readable factual content. ".repeat(10)}</main>
    </body></html>`;
    expect(loadHtml(html)).toBeDefined();
  });

  it("loads bounded XML and rejects deep XML", () => {
    expect(loadXml("<root><item>value</item></root>").root().text()).toContain(
      "value",
    );
    expect(() =>
      loadXml(`${"<item>".repeat(600)}x${"</item>".repeat(600)}`),
    ).toThrowError(expect.objectContaining({ code: "RESPONSE_TOO_LARGE" }));
    expect(loadXml("<root>" + "<item/>".repeat(600) + "</root>")).toBeDefined();
    expect(() =>
      loadXml(
        `<script>${"<node>".repeat(600)}x${"</node>".repeat(600)}</script>`,
      ),
    ).toThrowError(expect.objectContaining({ code: "RESPONSE_TOO_LARGE" }));
  });

  it("counts bogus declarations in the source node preflight", () => {
    expect(() => loadHtml("<!x>".repeat(100_001))).toThrowError(
      expect.objectContaining({ code: "RESPONSE_TOO_LARGE" }),
    );
  });

  it("selects non-overlapping HTML candidates and truncates returned text", () => {
    const html = `<html><head><meta property="og:title" content="  Fixture title  "></head><body>
      <main><article><h1>Heading</h1><p>${"Useful factual content. ".repeat(20)}</p></article></main>
    </body></html>`;
    const result = extractHtmlContent(loadHtml(html), "https://example.com/path", {
      maxCharacters: 100,
    });
    expect(result.title).toBe("Fixture title");
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(100);
    expect(result.characterCount).toBeGreaterThan(result.text.length);
  });

  it("falls back to body text and hostname and rejects insufficient pages", () => {
    const bodyOnly = `<html><body><div>${"Readable body text. ".repeat(10)}</div></body></html>`;
    expect(
      extractHtmlContent(loadHtml(bodyOnly), "https://example.com/path"),
    ).toMatchObject({ title: "example.com", truncated: false });
    expect(() =>
      extractHtmlContent(loadHtml("<html><body>tiny</body></html>"), "https://example.com/"),
    ).toThrowError(expect.objectContaining({ code: "CONTENT_INSUFFICIENT" }));
  });

  it("bounds the number of content candidates", () => {
    const html = `<html><body>${"<article>content</article>".repeat(513)}</body></html>`;
    expect(() =>
      extractHtmlContent(loadHtml(html), "https://example.com/"),
    ).toThrowError(expect.objectContaining({ code: "RESPONSE_TOO_LARGE" }));
  });

  it("bounds candidates across selectors and falls back from a short article to body", () => {
    const tooManyKinds = `<html><body>${Array.from(
      { length: 260 },
      () => "<article>short</article><main>short</main>",
    ).join("")}</body></html>`;
    expect(() =>
      extractHtmlContent(loadHtml(tooManyKinds), "https://example.com/"),
    ).toThrowError(expect.objectContaining({ code: "RESPONSE_TOO_LARGE" }));

    const bodyFallback = `<html><body><article>tiny</article><div>${
      "Useful factual body content. ".repeat(10)
    }</div></body></html>`;
    expect(
      extractHtmlContent(loadHtml(bodyFallback), "https://example.com/"),
    ).toMatchObject({
      text: expect.stringContaining("Useful factual body content"),
    });
  });

  it("scores an ancestor when a short nested article omits the main body", () => {
    const teaser = "Short introductory teaser. ".repeat(8);
    const fullArticle = "This is the complete article paragraph. ".repeat(80);
    const html = `<html><body><main>
      <article><p>${teaser}</p></article>
      <section><p>${fullArticle}</p></section>
    </main></body></html>`;
    const result = extractHtmlContent(loadHtml(html), "https://example.com/article");
    expect(result.text).toContain(teaser.trim().slice(0, 100));
    expect(result.text).toContain(fullArticle.trim().slice(0, 200));
    expect(result.text.length).toBeGreaterThanOrEqual(teaser.length + fullArticle.length);
  });

  it("prefers paragraph content over a similarly sized link-heavy candidate", () => {
    const links = Array.from(
      { length: 20 },
      (_, index) => `<a href="/item-${index}">${"Linked navigation text. ".repeat(4)}</a>`,
    ).join("");
    const article = "Independent factual paragraph content. ".repeat(35);
    const html = `<html><body>
      <div class="content">${links}</div>
      <article><p>${article}</p></article>
    </body></html>`;
    const result = extractHtmlContent(loadHtml(html), "https://example.com/article");
    expect(result.text).toContain(article.trim().slice(0, 200));
  });

  it("preserves direct candidate text that surrounds block elements", () => {
    const directText = "Direct article text remains part of the extracted result. ".repeat(4);
    const html = `<html><body><main>${directText}<p>Short paragraph.</p>${directText}</main></body></html>`;
    expect(
      extractHtmlContent(loadHtml(html), "https://example.com/"),
    ).toMatchObject({
      text: expect.stringContaining("Direct article text remains"),
    });
  });

  it("normalizes, truncates, and rejects insufficient plain text", () => {
    expect(
      extractPlainTextContent(
        "First line\r\n\r\n\r\nSecond line with enough text.",
        "https://example.com/",
        { maxCharacters: 25 },
      ),
    ).toMatchObject({ title: "example.com", truncated: true });
    expect(() =>
      extractPlainTextContent("tiny", "https://example.com/"),
    ).toThrowError(expect.objectContaining({ code: "CONTENT_INSUFFICIENT" }));
  });
});
