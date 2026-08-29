import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import { isLikelyDynamicHtml } from "../../src/retrieval/dynamic-content.js";

describe("dynamic content detection", () => {
  it("detects an empty framework root with executable scripts", () => {
    const html = `
      <html><body><div id="root"></div>
      <script type="module" src="/app.js"></script></body></html>`;
    expect(isLikelyDynamicHtml(load(html), html)).toBe(true);
  });

  it("does not classify server-rendered framework pages as empty shells", () => {
    const paragraph = "Server-rendered article content is already available. ".repeat(20);
    const html = `<html><body><div id="__next"><main>${paragraph}</main></div>
      <script src="/_next/static/app.js"></script></body></html>`;
    expect(isLikelyDynamicHtml(load(html), html)).toBe(false);
  });

  it("does not count script payloads as visible server-rendered content", () => {
    const payload = "client-only-data".repeat(100);
    const html = `<html><body><div id="root"></div>
      <script type="module">${payload}</script></body></html>`;

    expect(isLikelyDynamicHtml(load(html), html)).toBe(true);
  });

  it("handles a large single server-rendered text node with bounded sampling", () => {
    const html = `<html><body><div id="root">${"content ".repeat(
      200_000,
    )}</div><script type="module" src="/app.js"></script></body></html>`;
    expect(isLikelyDynamicHtml(load(html), html)).toBe(false);
  });
});
