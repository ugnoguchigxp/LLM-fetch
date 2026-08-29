import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import https from "node:https";
import { PassThrough, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { LlmFetchError, toLlmFetchError } from "../errors.js";
import { abortReason, isAbortSignal, waitWithSignal } from "../internal/abort-signal.js";
import {
  createDeadline,
  throwIfDeadlineElapsed,
  type Deadline,
} from "../internal/deadline.js";
import {
  defaultAddressResolver,
  resolveSafeOutboundUrl,
  type AddressResolver,
  type ResolvedAddress,
} from "./outbound-policy.js";

const DEFAULT_ALLOWED_CONTENT_TYPES = new Set([
  "text/html",
  "text/plain",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface SafeHttpFetcherOptions {
  timeoutMs?: number;
  maxWireBytes?: number;
  maxDecodedBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
  resolver?: AddressResolver;
  allowedContentTypes?: readonly string[];
}

export interface SafeFetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: Uint8Array;
  headers: Readonly<Record<string, string>>;
}

interface RequestResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: Uint8Array;
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      `${name} must be an integer between 1 and ${maximum}.`,
    );
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  return Array.isArray(value) ? value.join(", ") : (value ?? "");
}

function normalizedContentType(headers: IncomingHttpHeaders): string {
  return headerValue(headers, "content-type")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase() ?? "";
}

function decoderFor(response: IncomingMessage): Transform {
  const encoding = headerValue(response.headers, "content-encoding")
    .trim()
    .toLowerCase();
  switch (encoding) {
    case "":
    case "identity":
      return new PassThrough();
    case "gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      throw new LlmFetchError(
        "UNSUPPORTED_CONTENT_ENCODING",
        `Unsupported content encoding: ${encoding}`,
      );
  }
}

function collectBody(
  response: IncomingMessage,
  maxWireBytes: number,
  maxDecodedBytes: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const rawDeclaredLength = headerValue(response.headers, "content-length");
    if (rawDeclaredLength && !/^\d+$/.test(rawDeclaredLength)) {
      response.destroy();
      reject(new LlmFetchError("UPSTREAM_HTTP", "Response content-length is invalid."));
      return;
    }
    const declaredLength = Number(rawDeclaredLength || 0);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maxWireBytes) {
      response.destroy();
      reject(
        new LlmFetchError(
          "RESPONSE_TOO_LARGE",
          `Response content-length exceeds ${maxWireBytes} bytes.`,
        ),
      );
      return;
    }

    let decoder: Transform;
    try {
      decoder = decoderFor(response);
    } catch (error) {
      response.destroy();
      reject(error);
      return;
    }

    const chunks: Buffer[] = [];
    let wireBytes = 0;
    let decodedBytes = 0;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      response.destroy();
      decoder.destroy();
      reject(error);
    };

    response.on("data", (chunk: Buffer) => {
      wireBytes += chunk.length;
      if (wireBytes > maxWireBytes) {
        fail(
          new LlmFetchError(
            "RESPONSE_TOO_LARGE",
            `Compressed response exceeds ${maxWireBytes} bytes.`,
          ),
        );
      }
    });
    response.on("error", fail);
    response.on("aborted", () => {
      fail(new LlmFetchError("UPSTREAM_HTTP", "The response ended unexpectedly.", {
        retryable: true,
      }));
    });
    decoder.on("data", (chunk: Buffer) => {
      decodedBytes += chunk.length;
      if (decodedBytes > maxDecodedBytes) {
        fail(
          new LlmFetchError(
            "RESPONSE_TOO_LARGE",
            `Decoded response exceeds ${maxDecodedBytes} bytes.`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    decoder.on("error", fail);
    decoder.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, decodedBytes));
    });
    decoder.on("close", () => {
      if (!settled) {
        fail(new LlmFetchError("UPSTREAM_HTTP", "The decoded response ended unexpectedly.", {
          retryable: true,
        }));
      }
    });
    response.pipe(decoder);
  });
}

function requestOnce(
  url: URL,
  pinnedAddress: ResolvedAddress,
  deadline: Deadline,
  externalSignal: AbortSignal | undefined,
  headers: Record<string, string>,
  limits: { maxWireBytes: number; maxDecodedBytes: number },
  allowedContentTypes: ReadonlySet<string>,
): Promise<RequestResult> {
  throwIfDeadlineElapsed(deadline);
  const client = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: "GET",
        headers,
        signal: deadline.signal(externalSignal),
        lookup: (_hostname, lookupOptions, callback) => {
          if (lookupOptions.all) {
            callback(null, [{
              address: pinnedAddress.address,
              family: pinnedAddress.family,
            }]);
            return;
          }
          callback(null, pinnedAddress.address, pinnedAddress.family);
        },
      },
      (response) => {
        const status = response.statusCode ?? 500;
        if (REDIRECT_STATUSES.has(status) || status < 200 || status >= 300) {
          const responseHeaders = response.headers;
          response.destroy();
          resolve({ status, headers: responseHeaders, body: new Uint8Array() });
          return;
        }
        const contentType = normalizedContentType(response.headers);
        if (!allowedContentTypes.has(contentType)) {
          response.destroy();
          reject(
            new LlmFetchError(
              "UNSUPPORTED_CONTENT_TYPE",
              `Unsupported content type: ${contentType || "missing"}.`,
              { url: url.toString() },
            ),
          );
          return;
        }
        void collectBody(response, limits.maxWireBytes, limits.maxDecodedBytes).then(
          (body) => resolve({ status, headers: response.headers, body }),
          reject,
        );
      },
    );

    request.setTimeout(Math.max(1, deadline.remainingMs()), () => {
      request.destroy(new LlmFetchError("TIMEOUT", "HTTP request timed out.", { retryable: true }));
    });
    request.once("error", reject);
    request.end();
  });
}

function publicHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ["content-type", "content-language", "last-modified", "etag"]) {
    const value = headerValue(headers, name);
    if (value) result[name] = value;
  }
  return result;
}

function preferredAddress(addresses: readonly ResolvedAddress[]): ResolvedAddress {
  const address = addresses.find((entry) => entry.family === 4) ?? addresses[0];
  if (!address) {
    throw new LlmFetchError("UNSAFE_URL", "The URL hostname resolved to no addresses.");
  }
  return address;
}

export function createSafeHttpFetcher(options: SafeHttpFetcherOptions = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new LlmFetchError("INVALID_INPUT", "HTTP fetcher options must be an object.");
  }
  const timeoutMs = positiveInteger(options.timeoutMs ?? 10_000, "timeoutMs", 300_000);
  const maxWireBytes = positiveInteger(
    options.maxWireBytes ?? 1_000_000,
    "maxWireBytes",
    10_000_000,
  );
  const maxDecodedBytes = positiveInteger(
    options.maxDecodedBytes ?? 2_000_000,
    "maxDecodedBytes",
    10_000_000,
  );
  const maxRedirects = options.maxRedirects ?? 3;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "maxRedirects must be an integer between 0 and 10.",
    );
  }
  const resolver = options.resolver ?? defaultAddressResolver;
  if (typeof resolver !== "function") {
    throw new LlmFetchError("INVALID_INPUT", "resolver must be a function.");
  }
  if (
    options.allowedContentTypes !== undefined &&
    !Array.isArray(options.allowedContentTypes)
  ) {
    throw new LlmFetchError("INVALID_INPUT", "allowedContentTypes must be an array.");
  }
  const allowedContentTypes = new Set(
    (options.allowedContentTypes ?? [...DEFAULT_ALLOWED_CONTENT_TYPES]).map((type) =>
      typeof type === "string" ? type.trim().toLowerCase() : ""
    ),
  );
  if (
    allowedContentTypes.size === 0 ||
    [...allowedContentTypes].some(
      (type) => !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type),
    )
  ) {
    throw new LlmFetchError("INVALID_INPUT", "allowedContentTypes contains an invalid media type.");
  }
  const userAgent = options.userAgent ?? "llm-fetch/0.1";
  if (!userAgent.trim() || userAgent.length > 512 || hasControlCharacters(userAgent)) {
    throw new LlmFetchError("INVALID_INPUT", "userAgent contains invalid characters.");
  }
  const headers = {
    accept: "text/html,application/xhtml+xml,text/plain,application/xml,text/xml;q=0.9",
    "accept-encoding": "gzip, br, deflate",
    "user-agent": userAgent,
  };

  return async function safeFetch(
    rawUrl: string,
    input: { signal?: AbortSignal } = {},
  ): Promise<SafeFetchResult> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new LlmFetchError("INVALID_INPUT", "HTTP fetch input must be an object.");
    }
    if (input.signal !== undefined && !isAbortSignal(input.signal)) {
      throw new LlmFetchError("INVALID_INPUT", "signal must be an AbortSignal.");
    }
    input.signal?.throwIfAborted();
    const deadline = createDeadline(timeoutMs);
    let currentUrl = rawUrl;

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      throwIfDeadlineElapsed(deadline);
      let resolved: Awaited<ReturnType<typeof resolveSafeOutboundUrl>>;
      let response: RequestResult;
      try {
        resolved = await waitWithSignal(
          resolveSafeOutboundUrl(currentUrl, resolver),
          deadline.signal(input.signal),
        );
        response = await requestOnce(
          resolved.url,
          preferredAddress(resolved.addresses),
          deadline,
          input.signal,
          headers,
          { maxWireBytes, maxDecodedBytes },
          allowedContentTypes,
        );
      } catch (error) {
        if (error instanceof LlmFetchError) throw error;
        if (input.signal?.aborted) throw abortReason(input.signal);
        if (
          deadline.remainingMs() <= 0 ||
          (error instanceof Error && error.name === "TimeoutError")
        ) {
          throw new LlmFetchError("TIMEOUT", "Content retrieval timed out.", {
            url: currentUrl,
            retryable: true,
            cause: error,
          });
        }
        throw toLlmFetchError(error, {
          code: "UPSTREAM_HTTP",
          message: "Content retrieval failed.",
          url: currentUrl,
          retryable: true,
        });
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = headerValue(response.headers, "location");
        if (!location || redirectCount >= maxRedirects) {
          throw new LlmFetchError(
            "UPSTREAM_HTTP",
            "The redirect limit was exceeded.",
            { url: currentUrl, status: response.status },
          );
        }
        try {
          currentUrl = new URL(location, resolved.url).toString();
        } catch (error) {
          throw new LlmFetchError("UPSTREAM_HTTP", "The redirect target is invalid.", {
            url: currentUrl,
            status: response.status,
            cause: error,
          });
        }
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        throw new LlmFetchError(
          "UPSTREAM_HTTP",
          `Content endpoint returned HTTP ${response.status}.`,
          {
            url: currentUrl,
            status: response.status,
            retryable: response.status === 429 || response.status >= 500,
          },
        );
      }

      const contentType = normalizedContentType(response.headers);
      if (!allowedContentTypes.has(contentType)) {
        throw new LlmFetchError(
          "UNSUPPORTED_CONTENT_TYPE",
          `Unsupported content type: ${contentType || "missing"}.`,
          { url: currentUrl },
        );
      }

      return {
        requestedUrl: rawUrl,
        finalUrl: resolved.url.toString(),
        status: response.status,
        contentType,
        body: response.body,
        headers: publicHeaders(response.headers),
      };
    }

    throw new LlmFetchError("UPSTREAM_HTTP", "Content retrieval did not complete.", {
      url: rawUrl,
    });
  };
}

export type SafeHttpFetcher = ReturnType<typeof createSafeHttpFetcher>;
