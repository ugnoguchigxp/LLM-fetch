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

  it("expands merged cells while keeping values beneath their headers", () => {
    const result = convert(
      '<table><tr><th>Group</th><th colspan="2">Values</th></tr><tr><td rowspan="2">Shared label</td><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>',
    );
    expect(result).toBe(
      "|Group|Values|Values|\n|---|---|---|\n|Shared label|A|B|\n|Shared label|C|D|",
    );
    expect(result).not.toMatch(/<\/?(?:table|tr|td|th)\b/);
  });

  it("uses pipe tables for paragraph cells and pads missing cells without losing values", () => {
    expect(convert("<table><tr><td>A</td></tr><tr><td>B</td><td>C</td></tr></table>")).toBe(
      "|Column 1|Column 2|\n|---|---|\n|A||\n|B|C|",
    );
    expect(
      convert(
        "<table><tr><th>Time</th><th>Temperature</th></tr><tr><td><p>09:00</p></td><td><p>18.5</p><p>℃</p></td></tr></table>",
      ),
    ).toBe("|Time|Temperature|\n|---|---|\n|09:00|18.5 ℃|");
  });

  it("splits wide column-header tables with the row identifier and exact header-value pairs", () => {
    const header = Array.from({ length: 24 }, (_, index) => `<th>Hour ${index + 1}</th>`).join("");
    const values = Array.from({ length: 24 }, (_, index) => `<td>${index + 0.5}</td>`).join("");
    const result = convert(
      `<table><tr><th>Metric</th>${header}</tr><tr><th>Temperature</th>${values}</tr></table>`,
    );
    const blocks = result.split("\n\n");
    expect(blocks).toHaveLength(3);
    let hour = 1;
    for (const block of blocks) {
      const [head, separator, body] = block.split("\n").map((line) => line.slice(1, -1).split("|"));
      expect(head![0]).toBe("Metric");
      expect(body![0]).toBe("Temperature");
      expect(head!.length).toBeLessThanOrEqual(12);
      expect(separator).toHaveLength(head!.length);
      for (let column = 1; column < head!.length; column++, hour++) {
        expect(head![column]).toBe(`Hour ${hour}`);
        expect(body![column]).toBe(String(hour - 0.5));
      }
    }
    expect(hour).toBe(25);
  });

  it("keeps linked headings and table values inside otherwise link-heavy containers", () => {
    const result = convert(
      '<div><a href="/headline"><h2>Headline</h2></a><table><tr><th>Value</th></tr><tr><td><p><a href="/value">18.5</a></p></td></tr></table></div>',
    );
    expect(result).toContain("## Headline");
    expect(result).toContain("|Value|\n|---|\n|18.5|");
  });

  it("deduplicates adjacent icon labels without deleting repeated numeric values or prefix labels", () => {
    expect(convert('<div><img alt="晴"><p>晴</p><img alt="日の出">日の出｜05時45分</div>')).toBe(
      "晴\n\n日の出｜05時45分",
    );
    expect(convert('<p><img alt="北">北北西</p>')).toBe("北北北西");
    expect(convert("<table><tr><td>0</td><td>0</td></tr></table>")).toContain("|0|0|");
    expect(convert('<img alt="Only image value">')).toBe("Only image value");
  });

  it("deduplicates icon-only subrows only when the displayed value matches", () => {
    const icons = '<td><img alt="10"></td>'.repeat(13);
    const displayed = "<td>10</td>".repeat(12) + "<td>11</td>";
    const result = convert(
      `<table><tr><th rowspan="2">Reading</th>${icons}</tr><tr>${displayed}</tr></table>`,
    );
    expect(result).toContain("|Reading|\n|---|");
    expect(result.match(/\|10\|/g)).toHaveLength(12);
    expect(result).toContain("|10 / 11|");
    expect(result).not.toContain("10 / 10");
  });

  it("represents nested, code, and list tables without raw tags", () => {
    for (const html of [
      "<table><tr><td><table><tr><td>Nested</td></tr></table></td></tr></table>",
      "<table><tr><td><pre>  const x = 1;</pre></td></tr></table>",
      "<table><tr><td><ul><li>One</li><li>Two</li></ul></td></tr></table>",
    ]) {
      const result = convert(html);
      expect(result).toContain("Row 1");
      expect(result).not.toContain("<table");
    }
    expect(convert('<table><tr><td colspan="bad">Value</td></tr></table>')).toContain("|Value|");
    expect(
      convert('<table><tr><td rowspan="0">Shared</td><td>A</td></tr><tr><td>B</td></tr></table>'),
    ).toBe("|Column 1|Column 2|\n|---|---|\n|Shared|A|\n|Shared|B|");
  });

  it("omits semantic navigation in both HTML and mixed Markdown", () => {
    const html =
      '<nav><a href="/menu">Menu</a></nav><div role="NAVIGATION"><a href="/home">Home</a></div><p>Body content.</p>';
    expect(convert(html)).toBe("Body content.");
    expect(mixed(`# Guide\n\n${html}`)).toBe("# Guide\n\nBody content.");
  });

  it("retains nested link-heavy information as labels in HTML and mixed Markdown", () => {
    for (const tag of ["ul", "ol", "div", "section"]) {
      const content =
        '<a href="/forecast?very=long">Forecast</a><span> / </span><a href="/radar?very=long">Radar</a>';
      const html =
        tag === "ul" || tag === "ol"
          ? `<${tag}><li>${content}<ul><li><a href="/more">More</a></li></ul></li></${tag}>`
          : `<${tag}><div>${content}</div></${tag}>`;
      for (const result of [convert(html), mixed(`# Guide\n\n${html}`)]) {
        expect(result).toContain("Forecast / Radar");
        if (tag === "ul" || tag === "ol") expect(result).toContain("More");
        expect(result).not.toContain("https://");
        expect(result).not.toContain("very=long");
      }
    }
  });

  it("keeps URLs in prose references and only labels in standalone links", () => {
    const result = convert(
      '<main><p>A detailed explanation of the measurements with <a href="/docs">Docs</a> and <a href="/data">Data</a> for further reading.</p><ul><li>Use the <a href="/method">Method</a> to interpret measured temperatures.</li><li>Read the <a href="/results">Results</a> for the complete monthly comparison.</li></ul><p><a href="/reference">Reference</a></p></main>',
    );
    for (const destination of ["docs", "data", "method", "results"])
      expect(result).toContain(`https://example.com/${destination}`);
    expect(result).toContain("Reference");
    expect(result).not.toContain("https://example.com/reference");
    expect(convert('<a href="/3hours.html">3-hour forecast</a>')).toBe("3-hour forecast");
    expect(
      convert('<p><a href="https://example.com/source">https://example.com/source</a></p>'),
    ).toBe("https://example.com/source");
  });

  it.each(["ul", "ol", "div", "section", "p", "aside", "footer"])(
    "omits explicitly declared navigation while retaining the same unmarked content: %s",
    (tag) => {
      const content = '<a href="/one">One</a> / <a href="/two">Two</a>';
      const body = tag === "ul" || tag === "ol" ? `<li>${content}</li>` : content;
      for (const render of [convert, mixed]) {
        expect(render(`<${tag} role=" NAVIGATION ">${body}</${tag}><p>Body content.</p>`)).toBe(
          "Body content.",
        );
        expect(render(`<${tag}>${body}</${tag}><p>Body content.</p>`)).toContain("One / Two");
      }
    },
  );

  it.each([
    "Alpha / Beta",
    "Team A 1 — 4 Team B",
    "Workshop · Room C · 09:00",
    "Item D · available · ¥1,200",
  ])("preserves link-wrapped records independently of their words or values: %s", (text) => {
    for (const container of ["div", "section", "ul", "ol"]) {
      const record = `<a href="/detail?tracking=long"><div>${text}</div></a>`;
      const html = `<${container} id="menu" class="navigation footer">${
        container === "ul" || container === "ol" ? `<li>${record}</li>` : record
      }</${container}>`;
      for (const result of [convert(html), mixed(html)]) {
        expect(result).toContain(text);
        expect(result).not.toContain("tracking=");
        expect(result).not.toContain("https://");
      }
    }
  });

  it("resolves relative links and retains labels for unsupported URI schemes", () => {
    expect(
      convert(
        '<p>Read the full technical explanation in <a href="../reference?q=1&amp;x=2">Docs</a> and <a href="#install">Install</a> for the setup procedure.</p>',
      ),
    ).toContain("[Docs](https://example.com/reference?q=1&x=2)");
    expect(
      convert(
        '<p>Contact the editor for further information via <a href="mailto:reader@example.com">Email</a>.</p>',
      ),
    ).toContain("[Email](mailto:reader@example.com)");
    for (const href of ["javascript:alert(1)", "data:text/html,example", "http://[", ""]) {
      expect(convert(`<a href="${href}">Reference</a>`)).toBe("Reference");
    }
    expect(
      convert('<p>The complete reference is available at <a href="/a(b)">Parentheses</a>.</p>'),
    ).toContain("/a%28b%29");
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
    const result = mixed(
      '<p>See the complete technical explanation in <a href="/`&lt;script&gt;`">Reference</a>.</p>\n\n<p>Ending.</p>',
    );
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
    expect(() =>
      convert(`<table><tr><td colspan="1000">${"x".repeat(3_000)}</td></tr></table>`),
    ).toThrowError(expect.objectContaining({ code: "RESPONSE_TOO_LARGE" }));
    expect(() =>
      convert(
        `<table><tr><td colspan="1000">A</td></tr>${"<tr><td>B</td></tr>".repeat(1_001)}</table>`,
      ),
    ).toThrowError(expect.objectContaining({ code: "RESPONSE_TOO_LARGE" }));
  });
});
