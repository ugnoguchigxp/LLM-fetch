import type {
  CDPSession,
  Response as PlaywrightResponse,
} from "playwright-core";
import { LlmFetchError } from "../errors.js";
import { waitWithSignal } from "../internal/abort-signal.js";

function withOptionalSignal<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return signal ? waitWithSignal(operation, signal) : operation;
}
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function readableContentType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function responseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  // The browser has already decoded the navigation response and the rendered
  // DOM snapshot is encoded below with TextEncoder. Do not retain the original
  // response charset (or XHTML media type) for these new UTF-8 HTML bytes.
  const result: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
  };
  for (const name of ["content-language", "last-modified", "etag"]) {
    const value = headers[name];
    if (value && value.length <= 16_384) result[name] = value;
  }
  return result;
}

export function browserRequestHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const result = Object.create(null) as Record<string, string>;
  let count = 0;
  let totalLength = 0;
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (name === "authorization" || name === "proxy-authorization") continue;
    count += 1;
    totalLength += name.length + value.length;
    if (
      count > 100 ||
      name.length > 100 ||
      value.length > 16_384 ||
      totalLength > 64 * 1024 ||
      hasControlCharacters(name) ||
      /[\r\n]/u.test(value)
    ) {
      throw new LlmFetchError(
        "RESPONSE_TOO_LARGE",
        "The browser request headers exceeded the safety limit.",
      );
    }
    result[name] = value;
  }
  return result;
}

function declaredResponseLength(headers: Record<string, string>): number {
  const value = headers["content-length"];
  if (value === undefined) return 0;
  if (!/^\d+$/u.test(value)) {
    throw new LlmFetchError(
      "UPSTREAM_HTTP",
      "Browser response content-length is invalid.",
    );
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new LlmFetchError(
      "RESPONSE_TOO_LARGE",
      "Browser response is too large.",
    );
  }
  return length;
}

export async function validateNavigationResponse(
  response: PlaywrightResponse,
  maxResponseBytes: number,
  signal?: AbortSignal,
): Promise<{ status: number; headers: Record<string, string> }> {
  const status = response.status();
  if (status < 200 || status >= 300) {
    throw new LlmFetchError(
      "UPSTREAM_HTTP",
      `Browser navigation returned HTTP ${status}.`,
      {
        url: response.url(),
        status,
        retryable: status === 429 || status >= 500,
      },
    );
  }
  const headers = await withOptionalSignal(response.allHeaders(), signal);
  if (declaredResponseLength(headers) > maxResponseBytes) {
    throw new LlmFetchError(
      "RESPONSE_TOO_LARGE",
      "Browser response is too large.",
      { url: response.url() },
    );
  }
  const contentType = readableContentType(headers["content-type"] ?? "");
  if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
    throw new LlmFetchError(
      "UNSUPPORTED_CONTENT_TYPE",
      `Unsupported browser content type: ${contentType || "missing"}.`,
      { url: response.url() },
    );
  }
  return { status, headers };
}

export function monitorNetworkBudget(
  session: CDPSession,
  maxResponseBytes: number,
  onExceeded: (error: LlmFetchError) => void,
): void {
  interface RequestBytes {
    decoded: number;
    encoded: number;
    counted: number;
  }
  const requests = new Map<string, RequestBytes>();
  let totalBytes = 0;
  let exceeded = false;

  const failAccounting = () => {
    if (exceeded) return;
    exceeded = true;
    onExceeded(
      new LlmFetchError(
        "UPSTREAM_HTTP",
        "Chromium reported invalid network accounting data.",
      ),
    );
  };
  const updateTotal = (requestId: string, decoded: number, encoded: number) => {
    if (
      exceeded ||
      !Number.isFinite(decoded) ||
      decoded < 0 ||
      !Number.isFinite(encoded) ||
      encoded < 0
    ) {
      if (!exceeded) failAccounting();
      return;
    }
    const entry = requests.get(requestId) ?? {
      decoded: 0,
      encoded: 0,
      counted: 0,
    };
    entry.decoded += decoded;
    entry.encoded += encoded;
    const nextCounted = Math.max(entry.decoded, entry.encoded);
    totalBytes += nextCounted - entry.counted;
    entry.counted = nextCounted;
    requests.set(requestId, entry);
    if (
      !Number.isSafeInteger(entry.decoded) ||
      !Number.isSafeInteger(entry.encoded) ||
      !Number.isSafeInteger(totalBytes)
    ) {
      failAccounting();
      return;
    }
    if (totalBytes > maxResponseBytes) {
      exceeded = true;
      onExceeded(
        new LlmFetchError(
          "RESPONSE_TOO_LARGE",
          "The rendered page exceeded the total decoded or encoded network byte limit.",
        ),
      );
    }
  };

  session.on("Network.dataReceived", (event) => {
    updateTotal(event.requestId, event.dataLength, event.encodedDataLength);
  });
  session.on("Network.loadingFinished", (event) => {
    if (
      !Number.isFinite(event.encodedDataLength) ||
      event.encodedDataLength < 0
    ) {
      failAccounting();
      return;
    }
    const entry = requests.get(event.requestId);
    const encodedDelta = Math.max(
      0,
      event.encodedDataLength - (entry?.encoded ?? 0),
    );
    updateTotal(event.requestId, 0, encodedDelta);
    requests.delete(event.requestId);
  });
  session.on("Network.loadingFailed", (event) => {
    requests.delete(event.requestId);
  });
}
