import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("node:http", () => ({
  default: { request: (...args: unknown[]) => mocks.request(...args) },
}));
vi.mock("node:https", () => ({
  default: { request: (...args: unknown[]) => mocks.request(...args) },
}));

import { createSafeHttpFetcher } from "../../src/retrieval/http-fetcher.js";

interface MockResponse {
  aborted?: boolean;
  body?: Buffer | string;
  headers?: Record<string, string>;
  requestError?: Error;
  status?: number;
}

const queue: MockResponse[] = [];

beforeEach(() => {
  queue.length = 0;
  mocks.request.mockReset();
  mocks.request.mockImplementation(
    (
      _url: URL,
      _options: RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) => {
      const config = queue.shift();
      if (!config) throw new Error("No mock response queued");
      const request = new EventEmitter() as ClientRequest;
      request.setTimeout = vi.fn(() => request);
      request.destroy = vi.fn((error?: Error) => {
        if (error) queueMicrotask(() => request.emit("error", error));
        return request;
      });
      request.end = vi.fn(() => {
        queueMicrotask(() => {
          if (config.requestError) {
            request.emit("error", config.requestError);
            return;
          }
          const stream = new PassThrough();
          const response = Object.assign(stream, {
            headers: config.headers ?? { "content-type": "text/plain" },
            statusCode: config.status ?? 200,
          }) as unknown as IncomingMessage;
          callback(response);
          if (config.aborted) {
            stream.emit("aborted");
            return;
          }
          stream.end(config.body ?? "A sufficiently long plain text response for extraction.");
        });
        return request;
      });
      return request;
    },
  );
});

const resolver = async () => [{ address: "93.184.216.34", family: 4 as const }];

describe("safe HTTP fetcher", () => {
  it("pins the validated DNS address", async () => {
    queue.push({ body: "hello", headers: { "content-type": "text/plain" } });
    const fetcher = createSafeHttpFetcher({ resolver });

    await expect(fetcher("https://example.com/page")).resolves.toMatchObject({
      finalUrl: "https://example.com/page",
      contentType: "text/plain",
      body: Buffer.from("hello"),
    });
    const options = mocks.request.mock.calls[0]?.[1] as RequestOptions;
    const lookup = options.lookup as (
      hostname: string,
      options: object,
      callback: (error: null, address: string, family: number) => void,
    ) => void;
    const callback = vi.fn();
    lookup("example.com", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);

    const allCallback = vi.fn();
    lookup("example.com", { all: true }, allCallback);
    expect(allCallback).toHaveBeenCalledWith(null, [
      { address: "93.184.216.34", family: 4 },
    ]);
  });

  it("prefers a validated IPv4 answer when IPv6 is returned first", async () => {
    queue.push({ body: "hello", headers: { "content-type": "text/plain" } });
    const fetcher = createSafeHttpFetcher({
      resolver: async () => [
        { address: "2606:4700:4700::1111", family: 6 },
        { address: "93.184.216.34", family: 4 },
      ],
    });

    await fetcher("https://example.com/page");
    const options = mocks.request.mock.calls[0]?.[1] as RequestOptions;
    const lookup = options.lookup as (
      hostname: string,
      options: object,
      callback: (error: null, address: string, family: number) => void,
    ) => void;
    const callback = vi.fn();
    lookup("example.com", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });

  it("revalidates and follows a relative redirect", async () => {
    queue.push({ status: 302, headers: { location: "/final" } });
    queue.push({ body: "done", headers: { "content-type": "text/plain" } });
    const fetcher = createSafeHttpFetcher({ resolver });

    await expect(fetcher("https://example.com/start")).resolves.toMatchObject({
      finalUrl: "https://example.com/final",
    });
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it("limits both wire and decoded response sizes", async () => {
    queue.push({
      body: Buffer.alloc(11),
      headers: { "content-type": "text/plain" },
    });
    const wireFetcher = createSafeHttpFetcher({ resolver, maxWireBytes: 10 });
    await expect(wireFetcher("https://example.com/wire")).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });

    const compressed = gzipSync("x".repeat(100));
    queue.push({
      body: compressed,
      headers: {
        "content-type": "text/plain",
        "content-encoding": "gzip",
      },
    });
    const decodedFetcher = createSafeHttpFetcher({
      resolver,
      maxWireBytes: 1_000,
      maxDecodedBytes: 50,
    });
    await expect(decodedFetcher("https://example.com/decoded")).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });

    queue.push({
      body: "small",
      headers: {
        "content-type": "text/plain",
        "content-length": "9".repeat(400),
      },
    });
    await expect(createSafeHttpFetcher({ resolver })(
      "https://example.com/declared",
    )).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("rejects unsupported content types without exposing the body", async () => {
    queue.push({ body: "png-data", headers: { "content-type": "image/png" } });
    const fetcher = createSafeHttpFetcher({ resolver });
    await expect(fetcher("https://example.com/image")).rejects.toMatchObject({
      code: "UNSUPPORTED_CONTENT_TYPE",
    });
  });

  it("includes DNS resolution in the total deadline", async () => {
    const fetcher = createSafeHttpFetcher({
      timeoutMs: 5,
      resolver: async () => new Promise(() => undefined),
    });
    await expect(fetcher("https://example.com/hangs")).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("fails a response that closes before completion", async () => {
    queue.push({ aborted: true, headers: { "content-type": "text/plain" } });
    const fetcher = createSafeHttpFetcher({ resolver });
    await expect(fetcher("https://example.com/partial")).rejects.toMatchObject({
      code: "UPSTREAM_HTTP",
      retryable: true,
    });
  });

  it("rejects malformed redirect locations with a typed error", async () => {
    queue.push({ status: 302, headers: { location: "http://[" } });
    const fetcher = createSafeHttpFetcher({ resolver });
    await expect(fetcher("https://example.com/start")).rejects.toMatchObject({
      code: "UPSTREAM_HTTP",
    });
  });

  it("validates transport configuration eagerly", () => {
    expect(() => createSafeHttpFetcher({ timeoutMs: 0 })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => createSafeHttpFetcher({ maxRedirects: -1 })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => createSafeHttpFetcher({ allowedContentTypes: [] })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => createSafeHttpFetcher({
      allowedContentTypes: "text/html" as never,
    })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => createSafeHttpFetcher({ userAgent: "bad\nagent" })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("does not resolve or request an already aborted operation", async () => {
    const addressResolver = vi.fn(resolver);
    const fetcher = createSafeHttpFetcher({ resolver: addressResolver });
    const controller = new AbortController();
    controller.abort();
    await expect(fetcher("https://example.com/", {
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(addressResolver).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("validates the optional request object", async () => {
    const fetcher = createSafeHttpFetcher({ resolver });
    await expect(fetcher("https://example.com/", null as never)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
