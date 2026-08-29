import { describe, expect, it, vi } from "vitest";
import type { LlmFetchError } from "../../src/errors.js";
import {
  extractDuckDuckGoPreloadUrl,
  parseDuckDuckGoHtml,
  parseDuckDuckGoLite,
  parseDuckDuckGoWeb,
} from "../../src/providers/duckduckgo-parser.js";
import { duckDuckGo } from "../../src/providers/duckduckgo.js";

const HTML_RESULTS = `
<!doctype html>
<html><body>
  <div class="results">
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle%3Futm_source%3Dddg">Example Article</a>
      <a class="result__url">example.com/article</a>
      <div class="result__snippet">A useful result about TypeScript.</div>
    </div>
    <div class="result">
      <a class="result__a" href="https://example.org/guide">Second Guide</a>
      <div class="result__snippet">Another result.</div>
    </div>
  </div>
</body></html>`;

const LITE_RESULTS = `
<!doctype html>
<html><body><table>
  <tr><td><a class="result-link" href="https://example.net/lite">Lite Result</a></td></tr>
  <tr><td class="result-snippet">Lite result snippet text.</td></tr>
</table></body></html>`;

const WEB_RESULTS = `
DDG.pageLayout.load("d", [
  {"t":"TypeScript &amp; Web","a":"A <b>fast</b> signed result.","i":"example.dev","u":"https://example.dev/guide?utm_source=ddg"},
  {"n":"next page"},
  {"t":"Second result","a":"Another result.","i":"example.org","u":"https://example.org/two"}
]);`;

function bootstrapHtml(query: string): string {
  const preload = new URL("https://links.duckduckgo.com/d.js");
  preload.searchParams.set("q", query);
  preload.searchParams.set("vqd", "4-123456789012345678901234567890123456");
  return `
    <script>window.vqd="4-123456789012345678901234567890123456";</script>
    <script src="${preload.toString().replaceAll("&", "&amp;")}"></script>
  `;
}

describe("DuckDuckGo parsers", () => {
  it("maps, unwraps, normalizes, and ranks HTML results", () => {
    const hits = parseDuckDuckGoHtml(HTML_RESULTS, 10);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      provider: "duckduckgo",
      rank: 1,
      title: "Example Article",
      url: "https://example.com/article",
      snippet: "A useful result about TypeScript.",
    });
  });

  it("parses Lite results", () => {
    expect(parseDuckDuckGoLite(LITE_RESULTS, 5)[0]).toMatchObject({
      rank: 1,
      title: "Lite Result",
      url: "https://example.net/lite",
      snippet: "Lite result snippet text.",
    });
  });

  it("continues past duplicate URLs until it fills the requested limit", () => {
    const payload = `DDG.pageLayout.load("d", [
      {"t":"First","a":"one","u":"https://example.com/same"},
      {"t":"Duplicate","a":"two","u":"https://example.com/same"},
      {"t":"Unique","a":"three","u":"https://example.org/unique"}
    ]);`;
    expect(parseDuckDuckGoWeb(payload, 2).map((hit) => hit.url)).toEqual([
      "https://example.com/same",
      "https://example.org/unique",
    ]);
  });

  it("bounds the number of result candidates before decoding them", () => {
    const payload = `DDG.pageLayout.load("d", ${JSON.stringify(
      Array.from({ length: 1_001 }, (_, index) => ({
        t: `Result ${index}`,
        a: "description",
        u: `https://example.com/${index}`,
      })),
    )});`;
    expect(() => parseDuckDuckGoWeb(payload, 20)).toThrowError(
      expect.objectContaining({
        code: "RESPONSE_TOO_LARGE",
        provider: "duckduckgo",
      }),
    );
  });

  it("distinguishes no results, challenge, and parser changes", () => {
    expect(
      parseDuckDuckGoHtml("<div class='no-results'>No results.</div>", 5),
    ).toEqual([]);
    expect(() =>
      parseDuckDuckGoHtml("<form class='challenge-form'>captcha</form>", 5),
    ).toThrowError(expect.objectContaining({ code: "BOT_CHALLENGE" }));
    expect(() =>
      parseDuckDuckGoHtml("<html><body>unexpected</body></html>", 5),
    ).toThrowError(expect.objectContaining({ code: "PARSE_CHANGED" }));
  });

  it("rejects deeply nested provider HTML before parsing it", () => {
    const html = `${"<div>".repeat(600)}result${"</div>".repeat(600)}`;
    expect(() => parseDuckDuckGoHtml(html, 5)).toThrowError(
      expect.objectContaining({
        code: "RESPONSE_TOO_LARGE",
        provider: "duckduckgo",
      }),
    );
  });

  it("does not mistake an ordinary CAPTCHA search result for a challenge", () => {
    const html = HTML_RESULTS.replace(
      "Example Article",
      "CAPTCHA accessibility article",
    );
    expect(parseDuckDuckGoHtml(html, 10)[0]?.title).toBe(
      "CAPTCHA accessibility article",
    );
  });

  it("extracts and validates the provider-signed Web preload URL", () => {
    const url = extractDuckDuckGoPreloadUrl(
      bootstrapHtml("typescript retrieval"),
      "typescript retrieval",
    );
    expect(url.origin).toBe("https://links.duckduckgo.com");
    expect(url.pathname).toBe("/d.js");
    expect(url.searchParams.get("q")).toBe("typescript retrieval");
  });

  it("rejects a preload URL on an unexpected host", () => {
    const bootstrap = `
      <script>var vqd="4-123456789012345678901234567890123456";</script>
      <script src="https://attacker.example/d.js?q=test&amp;vqd=4-123456789012345678901234567890123456"></script>
    `;
    expect(() => extractDuckDuckGoPreloadUrl(bootstrap, "test")).toThrowError(
      expect.objectContaining({ code: "PARSE_CHANGED", retryable: false }),
    );
  });

  it("rejects ambiguous duplicate security parameters in a preload URL", () => {
    const bootstrap = bootstrapHtml("test").replace(
      "q=test",
      "q=test&amp;q=other",
    );
    expect(() => extractDuckDuckGoPreloadUrl(bootstrap, "test")).toThrowError(
      expect.objectContaining({ code: "PARSE_CHANGED" }),
    );
  });

  it("parses signed Web results without evaluating JavaScript", () => {
    expect(parseDuckDuckGoWeb(WEB_RESULTS, 5)).toEqual([
      expect.objectContaining({
        rank: 1,
        title: "TypeScript & Web",
        snippet: "A fast signed result.",
        url: "https://example.dev/guide",
      }),
      expect.objectContaining({
        rank: 2,
        title: "Second result",
        url: "https://example.org/two",
      }),
    ]);
  });

  it("recognizes the signed Web anomaly challenge", () => {
    expect(() =>
      parseDuckDuckGoWeb("DDG.deep.anomalyDetectionBlock('x')", 5),
    ).toThrowError(expect.objectContaining({ code: "BOT_CHALLENGE" }));
  });

  it("does not classify challenge terms inside ordinary results as a challenge", () => {
    const payload = `DDG.pageLayout.load("d", [{
      "t":"Understanding anomalyDetectionBlock",
      "a":"An article about the bot_challenge response name.",
      "u":"https://example.com/article"
    }]);`;
    expect(parseDuckDuckGoWeb(payload, 1)[0]?.title).toBe(
      "Understanding anomalyDetectionBlock",
    );
  });

  it("accepts an explicit empty signed Web result payload", () => {
    expect(parseDuckDuckGoWeb('DDG.pageLayout.load("d", []);', 5)).toEqual([]);
  });
});

describe("duckDuckGo provider", () => {
  it("uses the signed Web preload route on the normal path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(bootstrapHtml("typescript retrieval"), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(WEB_RESULTS, {
          status: 200,
          headers: { "content-type": "application/javascript" },
        }),
      );
    const provider = duckDuckGo({
      fetch: fetchMock as unknown as typeof fetch,
    });

    const hits = await provider.search({
      query: "typescript retrieval",
      limit: 1,
      locale: " jp-jp ",
      safeSearch: "strict",
      timeRange: "week",
    });

    expect(hits).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.origin).toBe("https://duckduckgo.com");
    expect(url.searchParams.get("q")).toBe("typescript retrieval");
    expect(url.searchParams.get("kl")).toBe("jp-jp");
    expect(url.searchParams.get("kp")).toBe("1");
    expect(url.searchParams.get("df")).toBe("w");
    expect(init.method).toBe("GET");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "https://links.duckduckgo.com/d.js?",
    );
    expect(
      (init.headers as Record<string, string>)["user-agent"],
    ).toContain("Mozilla/5.0");
  });

  it("maps ISO language and region to the DuckDuckGo region parameter", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(bootstrapHtml("mapping"), {
          headers: { "content-type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(WEB_RESULTS, {
          headers: { "content-type": "application/javascript" },
        }),
      );
    await duckDuckGo({ fetch: fetchMock as unknown as typeof fetch }).search({
      query: "mapping",
      language: "ja",
      region: "JP",
    });
    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.get("kl")).toBe("jp-jp");
  });

  it("maps a supported language-only input instead of silently dropping it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(bootstrapHtml("portuguese"), {
          headers: { "content-type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(WEB_RESULTS, {
          headers: { "content-type": "application/javascript" },
        }),
      );
    await duckDuckGo({ fetch: fetchMock as unknown as typeof fetch }).search({
      query: "portuguese",
      language: "pt",
    });
    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.get("kl")).toBe("pt-pt");
  });

  it("falls back through HTML to Lite for a retryable Web response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("failed", { status: 503 }))
      .mockResolvedValueOnce(new Response("pending", { status: 202 }))
      .mockResolvedValueOnce(
        new Response(LITE_RESULTS, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    const provider = duckDuckGo({
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(provider.search({ query: "fallback" })).resolves.toHaveLength(
      1,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://html.duckduckgo.com/html/",
    );
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe(
      "https://lite.duckduckgo.com/lite/",
    );
    const liteInit = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(
      (liteInit.headers as Record<string, string>)["sec-fetch-mode"],
    ).toBe("navigate");
  });

  it("returns a typed challenge when all routes respond with 202", async () => {
    const fetchMock = vi.fn(
      async () => new Response("challenge", { status: 202 }),
    );
    const provider = duckDuckGo({
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(provider.search({ query: "challenge" })).rejects.toMatchObject(
      {
        code: "BOT_CHALLENGE",
        status: 202,
        retryable: true,
      },
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not let later parse failures mask an earlier challenge", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("challenge", { status: 202 }))
      .mockResolvedValue(
        new Response("<html><body>unexpected</body></html>", {
          headers: { "content-type": "text/html" },
        }),
      );
    const provider = duckDuckGo({
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(provider.search({ query: "masked challenge" })).rejects.toMatchObject({
      code: "BOT_CHALLENGE",
      cooldownMs: 60_000,
    });
    await expect(provider.search({ query: "cooldown" })).rejects.toMatchObject({
      code: "BOT_CHALLENGE",
      cooldownMs: expect.any(Number),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a rate limit through the Lite endpoint", async () => {
    const fetchMock = vi.fn(
      async () => new Response("limited", { status: 429 }),
    );
    const provider = duckDuckGo({
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(provider.search({ query: "limited" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    } satisfies Partial<LlmFetchError>);
    await expect(
      provider.search({ query: "limited again" }),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      cooldownMs: expect.any(Number),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a later rate limit authoritative over an earlier challenge", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("challenge", { status: 202 }))
      .mockResolvedValueOnce(new Response("limited", { status: 429 }));
    const provider = duckDuckGo({
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(provider.search({ query: "limited fallback" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
    });
    await expect(provider.search({ query: "still limited" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      cooldownMs: expect.any(Number),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects redirects outside the fixed DuckDuckGo hosts", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/d.js" },
        }),
    );
    const provider = duckDuckGo({
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(provider.search({ query: "redirect" })).rejects.toMatchObject({
      code: "UNSAFE_URL",
      provider: "duckduckgo",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tries each route before cooling down after challenge bodies", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("<form class='challenge-form'>captcha</form>", {
          headers: { "content-type": "text/html" },
        }),
    );
    const provider = duckDuckGo({
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      provider.search({ query: "challenge body" }),
    ).rejects.toMatchObject({
      code: "BOT_CHALLENGE",
    });
    await expect(
      provider.search({ query: "challenge cooldown" }),
    ).rejects.toMatchObject({
      code: "BOT_CHALLENGE",
      cooldownMs: expect.any(Number),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid inputs without making a request", async () => {
    const fetchMock = vi.fn();
    const provider = duckDuckGo({
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(provider.search({ query: "  " })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(
      provider.search({ query: "ok", limit: 21 }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(
      provider.search({ query: "ok", language: "japanese" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      provider.search({ query: "ok", region: "JPN" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      provider.search({ query: "ok", locale: "jp-jp", language: "ja" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      provider.search({ query: "ok", language: "ja", region: "US" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      provider.search({ query: "ok", language: "xx" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates provider configuration eagerly", () => {
    expect(() => duckDuckGo({ timeoutMs: 0 })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => duckDuckGo({ maxResponseBytes: -1 })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => duckDuckGo({ userAgent: "bad\r\nheader" })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => duckDuckGo({ userAgent: "bad\0header" })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("adds provider context to bounded response errors", async () => {
    const provider = duckDuckGo({
      maxResponseBytes: 1,
      fetch: vi.fn(
        async () =>
          new Response("too large", {
            headers: {
              "content-length": "9",
              "content-type": "text/html",
            },
          }),
      ) as unknown as typeof fetch,
    });

    await expect(provider.search({ query: "bounded" })).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
      provider: "duckduckgo",
      retryable: false,
    });
  });

  it("times out a custom Fetch implementation that ignores its signal", async () => {
    const provider = duckDuckGo({
      timeoutMs: 5,
      fetch: vi.fn(
        () => new Promise<Response>(() => undefined),
      ) as unknown as typeof fetch,
    });

    await expect(provider.search({ query: "timeout" })).rejects.toMatchObject({
      code: "TIMEOUT",
      provider: "duckduckgo",
    });
  });

  it("cancels a stalled response body at the deadline", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const provider = duckDuckGo({
      timeoutMs: 5,
      fetch: vi.fn(
        async () =>
          new Response(body, {
            headers: { "content-type": "text/html" },
          }),
      ) as unknown as typeof fetch,
    });

    await expect(provider.search({ query: "timeout" })).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
