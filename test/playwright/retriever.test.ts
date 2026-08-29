import { describe, expect, it } from "vitest";
import { playwrightRetriever } from "../../src/playwright/retriever.js";

describe("Playwright retriever lifecycle", () => {
  it("validates options before importing the optional runtime", () => {
    expect(() => playwrightRetriever({ concurrency: 0 })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => playwrightRetriever({ userAgent: "invalid\r\nheader" })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() =>
      playwrightRetriever({ userAgent: 123 as never }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("validates retrieval input before DNS or browser startup", async () => {
    const retriever = playwrightRetriever();
    await expect(retriever.retrieve(
      "https://example.com/",
      { signal: {} as AbortSignal },
    )).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await retriever.close?.();
  });

  it("closes idempotently and cannot restart afterward", async () => {
    const retriever = playwrightRetriever();
    const first = retriever.close?.();
    const second = retriever.close?.();
    expect(first).toBe(second);
    await Promise.all([first, second]);

    await expect(retriever.isAvailable?.()).resolves.toBe(false);
    await expect(retriever.retrieve("https://example.com/")).rejects.toMatchObject({
      code: "CONFIG_MISSING",
    });
  });

  it("bounds DNS resolution even when called outside the client", async () => {
    const retriever = playwrightRetriever({
      navigationTimeoutMs: 100,
      settleTimeoutMs: 0,
      async resolver() {
        return new Promise(() => undefined);
      },
    });

    await expect(retriever.retrieve("https://example.com/")).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    await retriever.close?.();
  });
});
