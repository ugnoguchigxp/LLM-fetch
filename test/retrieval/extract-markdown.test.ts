import { describe, expect, it } from "vitest";
import { LlmFetchError } from "../../src/errors.js";
import { decodeBody } from "../../src/retrieval/extract-content.js";
import { extractMarkdownContent } from "../../src/retrieval/extract-markdown.js";

const MARKDOWN = [
  "# Test runner",
  "",
  "Use typed arguments with the HTTP API.",
  "",
  "- install",
  "  - dependencies",
  "    - lockfile",
  "",
  "1. Run the suite",
  "2. Read the report",
  "",
  "```ts",
  "const value = 1;",
  "```",
  "",
  "    indented code",
  "",
  "| API | Use |",
  "| --- | --- |",
  "| read | fetch |",
  "",
  "See https://example.com/docs for the endpoint.",
  "",
  "line break  ",
  "after two spaces",
  "",
  "",
  "end",
].join("\n");

describe("markdown extraction", () => {
  it("M01 preserves markdown structure aside from newline normalization", () => {
    const extracted = extractMarkdownContent(
      MARKDOWN.replaceAll("\n", "\r\n"),
      "https://example.com/guide.md",
    );
    expect(extracted.text).toBe(MARKDOWN);
    expect(extracted.characterCount).toBe(MARKDOWN.length);
    expect(extracted.truncated).toBe(false);
    expect(extracted.title).toBe("example.com");
    expect(extracted.text).toContain("  - dependencies");
    expect(extracted.text).toContain("https://example.com/docs");
    expect(extracted.text).toContain("line break  \nafter two spaces");
    expect(extracted.text).toContain("after two spaces\n\n\nend");
  });

  it("M02 decodes declared markdown charsets without changing structure", () => {
    const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(MARKDOWN)]);
    expect(decodeBody(utf8, "text/markdown")).toBe(MARKDOWN);
    const utf16 = Buffer.from(`\ufeff${MARKDOWN}`, "utf16le");
    expect(decodeBody(utf16, "text/markdown; charset=utf-16le")).toBe(MARKDOWN);
    expect(decodeBody(Buffer.from(MARKDOWN), "text/markdown; charset=Shift_JIS")).toBe(MARKDOWN);
    expect(
      extractMarkdownContent(decodeBody(utf8, "text/markdown"), "https://example.com/a").text,
    ).toBe(MARKDOWN);
  });

  it("M03 rejects invalid markdown bytes and unknown charsets", () => {
    expect(() => decodeBody(new Uint8Array([0xff]), "text/markdown; charset=utf-8")).toThrowError(
      LlmFetchError,
    );
    expect(() => decodeBody(new Uint8Array([0xff]), "text/markdown; charset=utf-8")).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_CONTENT_ENCODING" }),
    );
    expect(() => decodeBody(Buffer.from("ok"), "text/markdown; charset=x-unknown")).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_CONTENT_ENCODING" }),
    );
  });

  it("M12 truncates on a code-unit boundary without closing a fence", () => {
    const fence = "```ts\nconst value = 1;\n";
    const padding = "x".repeat(197);
    const text = `${fence}${padding}🙂`;
    const extracted = extractMarkdownContent(text, "https://example.com/long", {
      maxCharacters: 200,
      minCharacters: 20,
    });
    expect(extracted.truncated).toBe(true);
    expect(extracted.text.length).toBeLessThanOrEqual(200);
    expect(extracted.text.endsWith("\uD83D")).toBe(false);
    expect(extracted.text.includes("```ts")).toBe(true);
    expect(extracted.text.endsWith("```")).toBe(false);
    expect(extracted.characterCount).toBe(text.length);
    expect(extracted.excerpt?.length).toBeLessThanOrEqual(240);
  });

  it("M13 reports insufficient markdown text from the extractor", () => {
    expect(() => extractMarkdownContent("# Hi\n", "https://example.com/short")).toThrowError(
      expect.objectContaining({
        code: "CONTENT_INSUFFICIENT",
        reasonCode: "INSUFFICIENT_TEXT",
      }),
    );
  });
});
