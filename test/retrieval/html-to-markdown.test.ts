import { describe, expect, it } from "vitest";
import { loadHtml } from "../../src/retrieval/extract-content.js";
import { extractMarkdownContent } from "../../src/retrieval/extract-markdown.js";
import { htmlToMarkdown } from "../../src/retrieval/html-to-markdown.js";
import { prepareHtmlForExtraction } from "../../src/security/html-segments.js";

const URL = "https://example.com/docs/page";
function convert(html: string): string {
  const $ = loadHtml(html);
  prepareHtmlForExtraction($, html);
  return htmlToMarkdown($("body").get(0), URL);
}
function mixed(text: string): string {
  return extractMarkdownContent(text, URL, { minCharacters: 0 }).text;
}

describe("HTML-free structured Markdown", () => {
  it("preserves all heading levels and removes decorative attributes", () => {
    const html = Array.from(
      { length: 6 },
      (_, index) =>
        `<h${index + 1} class="decorative" id="s${index}">Section ${index + 1}</h${index + 1}>`,
    ).join("");
    const result = convert(html);
    for (let level = 1; level <= 6; level++)
      expect(result).toContain(`${"#".repeat(level)} Section ${level}`);
    expect(result).not.toContain("<h");
    expect(result).not.toContain("decorative");
  });

  it("preserves nested ordered and unordered lists and continuations", () => {
    const result = convert(
      '<ol start="3"><li>Prepare<ul><li>Node.js</li><li>Dependencies</li></ul><p>Then continue.</p></li><li value="8">Verify</li></ol>',
    );
    expect(result).toContain("3. Prepare");
    expect(result).toContain("   - Node.js");
    expect(result).toContain("   - Dependencies");
    expect(result).toContain("   Then continue.");
    expect(result).toContain("8. Verify");
    expect(convert("<ol reversed><li>One</li><li>Two</li></ol>")).toContain("2. One\n1. Two");
  });

  it("preserves code indentation, blank lines, language, and literal tags", () => {
    const result = convert(
      '<pre><code class="language-html">  &lt;div&gt;example&lt;/div&gt;\n\n\n```\n</code></pre>',
    );
    expect(result).toBe("````html\n  <div>example</div>\n\n\n```\n````");
    expect(convert("<p>Use <code>`value`</code> and <code> value </code>.</p>")).toBe(
      "Use `` `value` `` and `  value  `.",
    );
    expect(convert("<pre><code></code></pre>")).toBe("```\n\n```");
  });

  it("emits compact tables with explicit headers and escaped pipes", () => {
    expect(
      convert(
        "<table><caption>Settings</caption><tr><th>Key</th><th>Value</th></tr><tr><td>A|B</td><td>One<br>Two</td></tr></table>",
      ),
    ).toBe("Settings\n\n|Key|Value|\n|---|---|\n|A\\|B|One Two|");
    expect(convert("<table><tr><td>A</td><td>B</td></tr></table>")).toBe(
      "|Column 1|Column 2|\n|---|---|\n|A|B|",
    );
    expect(convert("<table><caption>Empty</caption></table>")).toBe("Empty");
  });

  it("preserves merged-cell coordinates without duplication or HTML fallback", () => {
    const result = convert(
      '<table><tr><th>Group</th><th colspan="2">Values</th></tr><tr><td rowspan="2">Shared label</td><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>',
    );
    expect(result).toContain("Column 2–3; header: Values");
    expect(result).toContain("Column 1; rows 2–3: Shared label");
    expect(result).toContain("- Row 3\n  - Column 2: C\n  - Column 3: D");
    expect(result.match(/Shared label/g)).toHaveLength(1);
    expect(result).not.toMatch(/<\/?(?:table|tr|td|th)\b/);
  });

  it("represents ragged, nested, multiline, and zero-rowspan tables without raw tags", () => {
    for (const html of [
      '<table><tr><td rowspan="0">Shared</td><td>A</td></tr><tr><td>B</td></tr></table>',
      "<table><tr><td>A</td></tr><tr><td>B</td><td>C</td></tr></table>",
      "<table><tr><td><table><tr><td>Nested</td></tr></table></td></tr></table>",
      "<table><tr><td><p>One</p><p>Two</p></td></tr></table>",
    ]) {
      const result = convert(html);
      expect(result).toContain("Row 1");
      expect(result).not.toContain("<table");
    }
    expect(convert('<table><tr><td colspan="bad">Value</td></tr></table>')).toContain("|Value|");
  });

  it("resolves relative links and retains labels for unsupported URI schemes", () => {
    expect(
      convert(
        '<p><a href="../reference?q=1&amp;x=2">Docs</a> and <a href="#install">Install</a></p>',
      ),
    ).toContain("[Docs](https://example.com/reference?q=1&x=2)");
    expect(convert('<a href="mailto:reader@example.com">Email</a>')).toBe(
      "[Email](mailto:reader@example.com)",
    );
    for (const href of ["javascript:alert(1)", "data:text/html,example", "http://[", ""]) {
      expect(convert(`<a href="${href}">Reference</a>`)).toBe("Reference");
    }
    expect(convert('<a href="/a(b)">Parentheses</a>')).toContain("/a%28b%29");
  });

  it("preserves emphasis, quotes, breaks, alt text and readable custom elements", () => {
    const result = convert(
      '<blockquote><p>A <strong>bold</strong> and <em>italic</em> note.</p></blockquote><hr><p>Line<br>Next <del>old</del><sup>2</sup><sub>x</sub></p><img alt="Diagram"><custom-box>Details</custom-box>',
    );
    expect(result).toContain("> A **bold** and *italic* note.");
    expect(result).toContain("---");
    expect(result).toContain("Line\nNext ~~old~~^(2)_(x)");
    expect(result).toContain("DiagramDetails");
    expect(result).not.toContain("<custom");
    expect(convert("<p>&lt;img src=x&gt; *literal* [label]</p>")).toBe(
      "&lt;img src=x&gt; \\*literal\\* \\[label\\]",
    );
  });

  it("removes hidden elements, comments, scripts and all attribute markup", () => {
    const result = convert(
      '<p onclick="something">Visible.</p><div hidden>Hidden</div><!--comment--><script>script text</script><style>style text</style><template>template</template><iframe>frame</iframe><input value="input"><details><summary>Summary</summary>Closed</details>',
    );
    expect(result).toContain("Visible.");
    expect(result).toContain("Summary");
    for (const removed of [
      "Hidden",
      "comment",
      "script text",
      "style text",
      "template",
      "frame",
      "input",
      "Closed",
      "onclick",
    ])
      expect(result).not.toContain(removed);
  });

  it("keeps whitespace outside emphasis markers so Markdown remains valid", () => {
    expect(
      convert("<p>A<strong> bold </strong>and<em> italic </em>note<del> old </del>end.</p>"),
    ).toBe("A **bold** and *italic* note ~~old~~ end.");
    expect(convert("<p>A<strong> </strong>B</p>")).toBe("A B");
  });

  it("preserves native Markdown around converted inline and block HTML", () => {
    const result = mixed(
      "# Guide\n\n- existing\n  - nested\n\nA <strong>bold</strong> word.\n\n<div><h2>Section</h2><p>Details.</p></div>\n\n[Original](https://example.com)",
    );
    expect(result).toContain("# Guide\n\n- existing\n  - nested");
    expect(result).toContain("A **bold** word.");
    expect(result).toContain("## Section\n\nDetails.");
    expect(result).toContain("[Original](https://example.com)");
    expect(result).not.toMatch(/<\/?(?:strong|div|h2|p)>/);
  });

  it.each([
    "```html\n<div>code</div>\n\n\n</T>\n```",
    "~~~~html\n<div>code</div>\n~~~\n~~~~",
    "> ```html\n> <div>quoted code</div>\n> ```",
    "- ```html\n  <div>list code</div>\n  ```",
    "    <div>indented code</div>\n    const x = 1;",
    "\t<div>tab-indented code</div>",
    "Use `<T>` and `` `<div>` `` as examples.",
    "See <https://example.com/docs> or <reader@example.com>.",
    "An escaped \\<div> opening bracket.",
  ])("keeps literal code, escapes and autolinks as data: %s", (literal) => {
    const result = mixed(`# Guide\n\n${literal}\n\n<p>Readable ending.</p>`);
    expect(result).toContain(literal);
    expect(result).toContain("Readable ending.");
    expect(result).not.toContain("<p>");
  });

  it("preserves an unclosed Markdown code fence as literal data", () => {
    const text = "# Guide\n\n```html\n<div>unclosed fence\n\n<p>Still code.</p>";
    expect(mixed(text)).toBe(text);
  });

  it("does not let literal HTML code tags change later Markdown code parsing", () => {
    const text =
      "Use `<code>` and `<pre>` as examples.\n\n```html\n<div>literal</div>\n```\n\n<p>Ending.</p>";
    expect(mixed(text)).toContain("```html\n<div>literal</div>\n```");
    expect(mixed(text)).toContain("Use `<code>` and `<pre>` as examples.");
  });

  it("preserves blank lines inside indented code in mixed Markdown", () => {
    const code = "    <div>literal</div>\n\n\n    const x = 1;";
    expect(mixed(`# Guide\n\n${code}\n\n<p>Ending.</p>`)).toContain(code);
  });

  it("keeps entity literals and HTML punctuation from creating new Markdown syntax", () => {
    const result = mixed(
      "&#35; literal heading &ast;literal&ast;\n\n<p>*literal* [label]</p>\n\n<pre>&lt;div&gt;&amp;&lt;/div&gt;</pre>",
    );
    expect(result).toContain("&#35; literal heading &ast;literal&ast;");
    expect(result).toContain("\\*literal\\* \\[label\\]");
    expect(result).toContain("```\n<div>&</div>\n```");
  });

  it("converts HTML within a Markdown list rather than treating it as indented code", () => {
    expect(
      mixed("- Existing\n\n    <strong>Nested continuation</strong>\n\n<p>Ending.</p>"),
    ).toContain("**Nested continuation**");
  });

  it("does not interpret code characters inside HTML attributes as Markdown", () => {
    const result = mixed('<a href="/`&lt;script&gt;`">Reference</a>\n\n<p>Ending.</p>');
    expect(result).not.toContain("<script>");
    expect(result).toContain("%3Cscript%3E");
    const pre = mixed("<pre>```\n&lt;div&gt;code&lt;/div&gt;\n```</pre>\n\n<p>Ending.</p>");
    expect(pre).toContain("````\n```\n<div>code</div>\n```\n````");
  });

  it("bounds conversion expansion and table width", () => {
    expect(() => convert("<p>" + "&amp;".repeat(410_000) + "</p>")).toThrowError(
      expect.objectContaining({ code: "RESPONSE_TOO_LARGE" }),
    );
    expect(() =>
      convert('<table><tr><td colspan="1000">A</td><td colspan="1000">B</td></tr></table>'),
    ).toThrowError(expect.objectContaining({ code: "RESPONSE_TOO_LARGE" }));
  });
});
