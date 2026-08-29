import { describe, expect, it, vi } from "vitest";
import type { SearchProvider } from "../../src/contracts.js";
import { brave } from "../../src/providers/brave.js";
import { fallbackSearch } from "../../src/providers/fallback.js";
import { LlmFetchError } from "../../src/errors.js";

describe("Brave provider", () => {
  it("maps valid results and does not read configuration from process.env", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        web: {
          results: [
            {
              title: "Example",
              url: "https://example.com/page?utm_source=brave",
              description: "Result description",
            },
          ],
        },
      }),
    );
    const provider = brave({
      apiKey: "test-key",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      provider.search({
        query: "typed search",
        limit: 3,
        locale: "ja-JP",
        timeRange: "week",
      }),
    ).resolves.toEqual([
      {
        trust: "untrusted",
        tainted: true,
        provider: "brave",
        rank: 1,
        title: "Example",
        url: "https://example.com/page",
        snippet: "Result description",
      },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.searchParams.get("count")).toBe("3");
    expect(url.searchParams.get("search_lang")).toBe("ja-JP");
    expect(url.searchParams.get("freshness")).toBe("pw");
    expect(new Headers(init.headers).get("x-subscription-token")).toBe(
      "test-key",
    );
  });

  it("returns typed upstream errors without leaking the API key", async () => {
    const fetchMock = vi.fn(
      async () => new Response("limited", { status: 429 }),
    );
    const provider = brave({
      apiKey: "super-secret-key",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const error = await provider
      .search({ query: "test" })
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(String(error)).not.toContain("super-secret-key");
    await expect(
      provider.search({ query: "test again" }),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      cooldownMs: expect.any(Number),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps provider-neutral language and region and honors bounded Retry-After", async () => {
    const successFetch = vi.fn(async () => Response.json({ web: { results: [] } }));
    const provider = brave({
      apiKey: "test",
      fetch: successFetch as unknown as typeof fetch,
    });
    await provider.search({ query: "mapping", language: "ja", region: "JP" });
    const [url] = successFetch.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.get("search_lang")).toBe("ja");
    expect(url.searchParams.get("country")).toBe("JP");

    const limited = brave({
      apiKey: "test",
      fetch: vi.fn(async () =>
        new Response("limited", {
          status: 429,
          headers: { "retry-after": "999999" },
        }),
      ) as unknown as typeof fetch,
    });
    await expect(limited.search({ query: "limited" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      cooldownMs: 300_000,
    });
  });

  it.each([
    { query: "ok", language: "japanese" },
    { query: "ok", region: "JPN" },
    { query: "ok", locale: "ja-JP", language: "ja" },
  ])("rejects invalid provider-neutral locale input: %o", async (input) => {
    const provider = brave({ apiKey: "test", fetch: vi.fn() as never });
    await expect(provider.search(input)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("validates provider configuration eagerly", () => {
    expect(() => brave({ apiKey: "test", timeoutMs: 0 })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => brave({ apiKey: "test", maxResponseBytes: -1 })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => brave(null as never)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => brave({ apiKey: 123 as never })).toThrowError(
      expect.objectContaining({ code: "CONFIG_MISSING" }),
    );
    expect(() => brave({ apiKey: "bad\0key" })).toThrowError(
      expect.objectContaining({ code: "CONFIG_MISSING" }),
    );
  });

  it("reports an unexpected successful response shape", async () => {
    const provider = brave({
      apiKey: "test",
      fetch: vi.fn(async () =>
        Response.json({ changed: true }),
      ) as unknown as typeof fetch,
    });
    await expect(provider.search({ query: "test" })).rejects.toMatchObject({
      code: "PARSE_CHANGED",
    });
  });

  it("adds provider context to bounded response errors", async () => {
    const provider = brave({
      apiKey: "test",
      maxResponseBytes: 1,
      fetch: vi.fn(
        async () =>
          new Response("too large", {
            headers: {
              "content-length": "9",
              "content-type": "application/json",
            },
          }),
      ) as unknown as typeof fetch,
    });

    await expect(provider.search({ query: "bounded" })).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
      provider: "brave",
      retryable: false,
    });
  });

  it("times out a custom Fetch implementation that ignores its signal", async () => {
    const provider = brave({
      apiKey: "test",
      timeoutMs: 5,
      fetch: vi.fn(
        () => new Promise<Response>(() => undefined),
      ) as unknown as typeof fetch,
    });

    await expect(provider.search({ query: "timeout" })).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });
});

describe("fallback provider", () => {
  it("moves to the next provider only for retryable errors", async () => {
    const first: SearchProvider = {
      name: "first",
      async search() {
        throw new LlmFetchError("UPSTREAM_HTTP", "temporary", {
          retryable: true,
        });
      },
    };
    const second: SearchProvider = {
      name: "second",
      async search() {
        return [
          {
            provider: "second",
            rank: 1,
            title: "ok",
            url: "https://example.com/",
            snippet: "",
          },
        ];
      },
    };
    await expect(
      fallbackSearch([first, second]).search({ query: "test" }),
    ).resolves.toHaveLength(1);
  });

  it("does not fall back for empty results or non-retryable errors", async () => {
    const empty: SearchProvider = {
      name: "empty",
      async search() {
        return [];
      },
    };
    const unused = {
      name: "unused",
      search: vi.fn(async () => []),
    } satisfies SearchProvider;
    await expect(
      fallbackSearch([empty, unused]).search({ query: "test" }),
    ).resolves.toEqual([]);
    expect(unused.search).not.toHaveBeenCalled();

    const invalid: SearchProvider = {
      name: "invalid",
      async search() {
        throw new LlmFetchError("INVALID_INPUT", "bad input");
      },
    };
    await expect(
      fallbackSearch([invalid, unused]).search({ query: "test" }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(unused.search).not.toHaveBeenCalled();
  });

  it("bounds fallback chain configuration", () => {
    const providers = Array.from(
      { length: 11 },
      (_, index) =>
        ({
          name: `provider-${index}`,
          async search() {
            return [];
          },
        }) satisfies SearchProvider,
    );
    expect(() => fallbackSearch(providers)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });
});
