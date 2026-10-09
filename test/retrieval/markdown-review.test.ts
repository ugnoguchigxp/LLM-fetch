import { describe, expect, it } from "vitest";
import { loadHtml } from "../../src/retrieval/extract-content.js";
import {
  extractMarkdownContent,
  limitMarkdownReturn,
} from "../../src/retrieval/extract-markdown.js";
import { htmlToMarkdown } from "../../src/retrieval/html-to-markdown.js";

const URL = "https://example.com/guide";
const mixed = (text: string) => extractMarkdownContent(text, URL, { minCharacters: 0 }).text;
const html = (text: string) => htmlToMarkdown(loadHtml(text)("body").get(0), URL);

describe("Markdown output review regressions", () => {
  it("ends a quoted fence when the quote container ends", () => {
    const result = mixed(
      "> ```html\n> <div>literal code</div>\n\n<section>Outside the quote.</section>\n\n<p>Ending.</p>",
    );
    expect(result).toContain("> ```html\n> <div>literal code</div>");
    expect(result).toContain("Outside the quote.");
    expect(result).not.toContain("<section>");
    expect(result).not.toContain("<p>");
  });

  it("ends a list fence when the list item ends", () => {
    const result = mixed("- ```html\n  <div>literal</div>\n\n<section>Outside the list.</section>");
    expect(result).toContain("- ```html\n  <div>literal</div>");
    expect(result).not.toContain("<section>");
  });

  it("does not treat backticks across separate paragraphs as a code span", () => {
    const result = mixed(
      "An unmatched ` delimiter.\n\n<div>Visible paragraph.</div>\n\nAnother ` delimiter.",
    );
    expect(result).toContain("Visible paragraph.");
    expect(result).not.toContain("<div>");
  });

  it.each(["---", "===", "* * *", "<center>Block text.</center>", "</div>", "<!-- comment -->"])(
    "does not let a code span cross a block boundary: %s",
    (separator) => {
      const result = mixed(
        `An unmatched \` delimiter.\n${separator}\n<span>Visible outside code.</span>\nAnother \` delimiter.`,
      );
      expect(result).not.toContain("<span>");
      expect(result).toContain("Visible outside code.");
    },
  );

  it("does not let table code spans cross cells or rows", () => {
    const result = mixed(
      "| Label | Value |\n|---|---|\n| unmatched ` | <span>Visible outside code.</span> |\n| Another ` | Value |\n\n<p>Ending.</p>",
    );
    expect(result).not.toContain("<span>");
    expect(result).toContain("Visible outside code.");
  });

  it("keeps indented code inside a block quote as literal code", () => {
    expect(mixed(">     <div>literal</div>\n>     const x = 1;\n\n<p>Ending.</p>")).toContain(
      ">     <div>literal</div>\n>     const x = 1;",
    );
  });

  it("emits a table cell code block as a block rather than after a label", () => {
    const result = html(
      '<table><tr><td><pre><code class="language-html">&lt;div&gt;literal&lt;/div&gt;</code></pre></td></tr></table>',
    );
    expect(result).toContain("  - Column 1:\n\n    ```html\n    <div>literal</div>\n    ```");
    expect(result).not.toContain("Column 1: ```");
  });

  it("does not let rowspan zero cross a row group", () => {
    const result = html(
      '<table><thead><tr><th rowspan="0">Header</th><th>Other</th></tr></thead><tbody><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></tbody></table>',
    );
    expect(result).not.toContain("rows 1–3");
    expect(result).not.toContain("Column 3");
  });

  it("does not turn a truncated inline code example back into raw HTML", () => {
    const text = "Public reference. `" + "<div>literal</div> ".repeat(20) + "` Ending.";
    const result = limitMarkdownReturn(text, 200);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(200);
    expect(result.text).toMatch(/`[^`]+`$/);
  });

  it("preserves quoted prose and multiline inline code around converted HTML", () => {
    expect(
      mixed("> Quoted reference.\n\nUse `<T>\nand U` in examples.\n\n<p>Ending.</p>"),
    ).toContain("> Quoted reference.\n\nUse `<T>\nand U` in examples.");
  });

  it("does not change all-space inline code or emit empty code delimiters", () => {
    expect(html("<p>A<code></code>B <code>  </code>.</p>")).toBe("AB `  `.");
  });

  it("preserves block content inside links instead of flattening its structure", () => {
    const result = html(
      '<a href="/details"><h2>Details</h2><p>Reference text.</p><pre>&lt;div&gt;code&lt;/div&gt;</pre></a>',
    );
    expect(result).toContain("## Details\n\nReference text.");
    expect(result).toContain("```\n<div>code</div>\n```");
    expect(result).toContain("[Link](https://example.com/details)");
  });

  it("does not corrupt a code block when recovering unusual HTML nesting", () => {
    for (const element of ["h2", "strong", "em"]) {
      expect(html(`<${element}><pre>&lt;div&gt;literal&lt;/div&gt;</pre></${element}>`)).toBe(
        "```\n<div>literal</div>\n```",
      );
    }
  });

  it.each(["<div>literal</div>", "`<div>`", "  <div>  ", "🙂<div>🙂"])(
    "keeps truncated inline code delimiters separate from its content: %s",
    (content) => {
      const text = `Before. \`\` ${Array(30).fill(content).join(" ")} \`\` After.`;
      const result = limitMarkdownReturn(text, 80);
      expect(result.text.length).toBeLessThanOrEqual(80);
      expect(result.text).toMatch(/`` [\s\S]+[^`]``$/);
      expect(result.text).not.toMatch(/[\uD800-\uDBFF]``$/);
    },
  );

  it("keeps a linked heading as a heading and a single linked pre as code", () => {
    expect(html('<a href="/details"><h2>Details</h2></a>')).toBe(
      "## [Details](https://example.com/details)",
    );
    expect(html('<a href="/details"><pre>&lt;div&gt;literal&lt;/div&gt;</pre></a>')).toContain(
      "```\n<div>literal</div>\n```",
    );
  });

  it("preserves empty lines in code blocks inside lists and quotes", () => {
    for (const container of ["<ul><li>", "<ol><li>", "<blockquote>"]) {
      const close = container.includes("li")
        ? `</li></${container.includes("ul") ? "ul" : "ol"}>`
        : "</blockquote>";
      const result = html(`${container}<pre>first\n\n\nlast</pre>${close}`);
      expect(result.split("\n").filter((line) => !line.replace(/^> ?/, "").trim())).toHaveLength(2);
    }
  });
});
