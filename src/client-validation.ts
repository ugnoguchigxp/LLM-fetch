import { isIP } from "node:net";
import type { ReadInput, SearchHit, SearchInput } from "./contracts.js";
import { LlmFetchError } from "./errors.js";
import { isAbortSignal } from "./internal/abort-signal.js";
import type { ContentRetrievalResult } from "./retrieval/content-retriever.js";
import { isPublicIpAddress } from "./retrieval/outbound-policy.js";
import { normalizeResultUrl } from "./retrieval/url-normalizer.js";

const REQUESTED_USES = new Set([
  "summarize",
  "answer_with_citation",
  "extract_facts",
  "search_more",
  "call_readonly_tool",
]);
const SAFE_SEARCH_VALUES = new Set(["strict", "moderate", "off"]);
const TIME_RANGES = new Set(["day", "week", "month", "year"]);
export const RENDER_MODES = new Set(["never", "auto", "always"]);
export const READABLE_CONTENT_TYPES = new Set([
  "text/html",
  "text/plain",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
]);

export function searchCacheKey(provider: string, input: SearchInput): string {
  return JSON.stringify([
    provider,
    input.query.trim(),
    input.limit ?? 10,
    input.safeSearch ?? "moderate",
    input.locale ?? "",
    input.language ?? "",
    input.region ?? "",
    input.timeRange ?? "",
  ]);
}

export function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function normalizeExternalText(value: string): string {
  let normalized = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      if (code === 0x09 || code === 0x0a || code === 0x0d) normalized += " ";
      continue;
    }
    normalized += character;
  }
  return normalized.replace(/\s+/gu, " ").trim();
}

export function integerInRange(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value as number;
}

export function optionalRequestedUse(value: unknown): ReadInput["requestedUse"] {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !REQUESTED_USES.has(value)) {
    throw new LlmFetchError("INVALID_INPUT", "requestedUse is invalid.");
  }
  return value as NonNullable<ReadInput["requestedUse"]>;
}

export function normalizeSearchInput(input: SearchInput): SearchInput {
  if (!input || typeof input !== "object" || typeof input.query !== "string") {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "Search input and query are required.",
    );
  }
  const query = input.query.trim();
  if (!query || query.length > 400) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "Search query must contain between 1 and 400 characters.",
    );
  }
  const limit = integerInRange(input.limit ?? 10, "limit", 1, 20);
  if (
    input.safeSearch !== undefined &&
    (typeof input.safeSearch !== "string" ||
      !SAFE_SEARCH_VALUES.has(input.safeSearch))
  ) {
    throw new LlmFetchError("INVALID_INPUT", "safeSearch is invalid.");
  }
  if (
    input.timeRange !== undefined &&
    (typeof input.timeRange !== "string" || !TIME_RANGES.has(input.timeRange))
  ) {
    throw new LlmFetchError("INVALID_INPUT", "timeRange is invalid.");
  }
  let locale: string | undefined;
  if (input.locale !== undefined) {
    if (
      typeof input.locale !== "string" ||
      !input.locale.trim() ||
      input.locale.length > 100 ||
      hasControlCharacters(input.locale)
    ) {
      throw new LlmFetchError("INVALID_INPUT", "locale is invalid.");
    }
    locale = input.locale.trim();
  }
  let language: string | undefined;
  if (input.language !== undefined) {
    if (
      typeof input.language !== "string" ||
      !/^[a-z]{2}$/iu.test(input.language)
    ) {
      throw new LlmFetchError(
        "INVALID_INPUT",
        "language must be an ISO 639-1 two-letter code.",
      );
    }
    language = input.language.toLowerCase();
  }
  let region: string | undefined;
  if (input.region !== undefined) {
    if (
      typeof input.region !== "string" ||
      !/^[a-z]{2}$/iu.test(input.region)
    ) {
      throw new LlmFetchError(
        "INVALID_INPUT",
        "region must be an ISO 3166-1 alpha-2 code.",
      );
    }
    region = input.region.toUpperCase();
  }
  if (locale !== undefined && (language !== undefined || region !== undefined)) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "locale cannot be combined with language or region.",
    );
  }
  if (input.signal !== undefined && !isAbortSignal(input.signal)) {
    throw new LlmFetchError("INVALID_INPUT", "signal must be an AbortSignal.");
  }
  const normalized: SearchInput = { query, limit };
  if (input.safeSearch !== undefined) normalized.safeSearch = input.safeSearch;
  if (locale !== undefined) normalized.locale = locale;
  if (language !== undefined) normalized.language = language;
  if (region !== undefined) normalized.region = region;
  if (input.timeRange !== undefined) normalized.timeRange = input.timeRange;
  if (input.signal !== undefined) normalized.signal = input.signal;
  return normalized;
}

export function normalizeReadInput(input: ReadInput): ReadInput {
  if (!input || typeof input !== "object" || typeof input.url !== "string") {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "Read input and URL are required.",
    );
  }
  const url = input.url.trim();
  if (!url || url.length > 2_048) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "URL must contain between 1 and 2048 characters.",
    );
  }
  if (input.signal !== undefined && !isAbortSignal(input.signal)) {
    throw new LlmFetchError("INVALID_INPUT", "signal must be an AbortSignal.");
  }
  const normalized: ReadInput = { url };
  if (input.maxCharacters !== undefined) {
    normalized.maxCharacters = integerInRange(
      input.maxCharacters,
      "maxCharacters",
      200,
      100_000,
    );
  }
  if (
    input.render !== undefined &&
    (typeof input.render !== "string" || !RENDER_MODES.has(input.render))
  ) {
    throw new LlmFetchError("INVALID_INPUT", "render is invalid.");
  }
  if (input.render !== undefined) normalized.render = input.render;
  const requestedUse = optionalRequestedUse(input.requestedUse);
  if (requestedUse !== undefined) normalized.requestedUse = requestedUse;
  if (input.signal !== undefined) normalized.signal = input.signal;
  if (input.source !== undefined) {
    const source = input.source;
    if (
      !source ||
      typeof source !== "object" ||
      typeof source.provider !== "string" ||
      !source.provider.trim() ||
      source.provider.length > 100 ||
      typeof source.query !== "string" ||
      !source.query.trim() ||
      source.query.length > 400
    ) {
      throw new LlmFetchError("INVALID_INPUT", "source metadata is invalid.");
    }
    const rank = integerInRange(source.rank, "source.rank", 1, 1_000_000);
    if (
      source.snippet !== undefined &&
      (typeof source.snippet !== "string" || source.snippet.length > 10_000)
    ) {
      throw new LlmFetchError("INVALID_INPUT", "source.snippet is invalid.");
    }
    const normalizedProvider = normalizeExternalText(source.provider);
    if (!normalizedProvider) {
      throw new LlmFetchError("INVALID_INPUT", "source.provider is invalid.");
    }
    normalized.source = {
      provider: normalizedProvider,
      query: source.query.trim(),
      rank,
    };
    if (source.snippet !== undefined) {
      normalized.source.snippet = normalizeExternalText(source.snippet);
    }
  }
  return normalized;
}

export function normalizeSearchHits(
  value: unknown,
  provider: string,
  limit: number,
): SearchHit[] {
  if (!Array.isArray(value)) {
    throw new LlmFetchError(
      "PARSE_CHANGED",
      "Search provider returned a non-array result.",
      { provider },
    );
  }
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  if (value.length > 1_000) {
    throw new LlmFetchError(
      "PARSE_CHANGED",
      "Search provider returned too many results.",
      { provider },
    );
  }
  for (const item of value) {
    if (!item || typeof item !== "object") {
      throw new LlmFetchError(
        "PARSE_CHANGED",
        "Search provider returned an invalid result.",
        { provider },
      );
    }
    const hit = item as Partial<SearchHit>;
    const normalizedUrl =
      typeof hit.url === "string" ? normalizeResultUrl(hit.url) : null;
    if (
      typeof hit.provider !== "string" ||
      !hit.provider.trim() ||
      hit.provider.length > 100 ||
      typeof hit.title !== "string" ||
      !hit.title.trim() ||
      hit.title.length > 1_000 ||
      typeof hit.snippet !== "string" ||
      hit.snippet.length > 10_000 ||
      !Number.isSafeInteger(hit.rank) ||
      (hit.rank as number) < 1 ||
      (hit.rank as number) > 1_000_000 ||
      !normalizedUrl ||
      normalizedUrl.length > 2_048 ||
      (hit.displayUrl !== undefined &&
        (typeof hit.displayUrl !== "string" || hit.displayUrl.length > 2_048))
    ) {
      throw new LlmFetchError(
        "PARSE_CHANGED",
        "Search provider returned an invalid result.",
        { provider },
      );
    }
    if (seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);
    const normalizedHit: SearchHit = {
      trust: "untrusted",
      tainted: true,
      provider: normalizeExternalText(hit.provider),
      rank: hits.length + 1,
      title: normalizeExternalText(hit.title),
      url: normalizedUrl,
      snippet: normalizeExternalText(hit.snippet),
    };
    if (!normalizedHit.provider || !normalizedHit.title) {
      throw new LlmFetchError(
        "PARSE_CHANGED",
        "Search provider returned an invalid result.",
        { provider },
      );
    }
    if (hit.displayUrl !== undefined && hit.displayUrl.trim()) {
      const displayUrl = normalizeExternalText(hit.displayUrl);
      if (displayUrl) normalizedHit.displayUrl = displayUrl;
    }
    hits.push(normalizedHit);
    if (hits.length >= limit) break;
  }
  return hits;
}

export function validateNonNegativeInteger(
  value: number,
  name: string,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      `${name} must be an integer between 0 and ${maximum}.`,
    );
  }
  return value;
}

export function isTimeoutReason(value: unknown): boolean {
  return value instanceof DOMException && value.name === "TimeoutError";
}

export function timeoutError(
  message: string,
  url?: string,
  cause?: unknown,
): LlmFetchError {
  return new LlmFetchError("TIMEOUT", message, {
    ...(url === undefined ? {} : { url }),
    retryable: true,
    cause,
  });
}

export function validateFetchResult(
  value: unknown,
  requestedUrl: string,
): ContentRetrievalResult {
  if (!value || typeof value !== "object") {
    throw new LlmFetchError(
      "UPSTREAM_HTTP",
      "Fetcher returned an invalid response.",
      { url: requestedUrl },
    );
  }
  const result = value as Partial<ContentRetrievalResult>;
  const resultRequestedUrl =
    typeof result.requestedUrl === "string" ? result.requestedUrl : "";
  const normalizedRequestedUrl = resultRequestedUrl
    ? normalizeResultUrl(resultRequestedUrl)
    : null;
  const expectedRequestedUrl = normalizeResultUrl(requestedUrl);
  const finalUrl = typeof result.finalUrl === "string" ? result.finalUrl : "";
  const normalizedFinalUrl = finalUrl ? normalizeResultUrl(finalUrl) : null;
  const parsedFinalUrl = normalizedFinalUrl
    ? new URL(normalizedFinalUrl)
    : undefined;
  const finalHostname = parsedFinalUrl?.hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  const contentType =
    typeof result.contentType === "string"
      ? result.contentType.trim().toLowerCase()
      : "";
  if (
    !normalizedRequestedUrl ||
    normalizedRequestedUrl !== expectedRequestedUrl ||
    resultRequestedUrl.length > 2_048 ||
    !normalizedFinalUrl ||
    !parsedFinalUrl ||
    (parsedFinalUrl.port !== "" &&
      parsedFinalUrl.port !== (parsedFinalUrl.protocol === "https:" ? "443" : "80")) ||
    !finalHostname ||
    finalHostname === "localhost" ||
    finalHostname.endsWith(".localhost") ||
    finalHostname.endsWith(".local") ||
    finalHostname === "home.arpa" ||
    finalHostname.endsWith(".home.arpa") ||
    (isIP(finalHostname) !== 0 && !isPublicIpAddress(finalHostname)) ||
    finalUrl.length > 2_048 ||
    !Number.isInteger(result.status) ||
    (result.status as number) < 200 ||
    (result.status as number) >= 300 ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType) ||
    !(result.body instanceof Uint8Array) ||
    result.body.byteLength > 10_000_000 ||
    (result.fetchMethod !== "http" && result.fetchMethod !== "playwright") ||
    !result.headers ||
    typeof result.headers !== "object" ||
    Array.isArray(result.headers)
  ) {
    throw new LlmFetchError(
      "UPSTREAM_HTTP",
      "Fetcher returned an invalid response.",
      { url: requestedUrl },
    );
  }
  if (
    result.limitations !== undefined &&
    (!Array.isArray(result.limitations) ||
      result.limitations.length > 100 ||
      result.limitations.some(
        (item) => typeof item !== "string" || item.length > 1_000,
      ))
  ) {
    throw new LlmFetchError(
      "UPSTREAM_HTTP",
      "Fetcher returned invalid limitations.",
      { url: requestedUrl },
    );
  }
  const headers = Object.create(null) as Record<string, string>;
  let headerCount = 0;
  let headerLength = 0;
  for (const [name, headerValue] of Object.entries(result.headers)) {
    headerCount += 1;
    headerLength +=
      name.length + (typeof headerValue === "string" ? headerValue.length : 0);
    if (
      typeof headerValue !== "string" ||
      headerCount > 100 ||
      headerLength > 64 * 1024 ||
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name) ||
      name.length > 100 ||
      headerValue.length > 16_384 ||
      hasControlCharacters(name) ||
      /[\r\n]/u.test(headerValue) ||
      Object.hasOwn(headers, name.toLowerCase())
    ) {
      throw new LlmFetchError(
        "UPSTREAM_HTTP",
        "Fetcher returned invalid headers.",
        { url: requestedUrl },
      );
    }
    headers[name.toLowerCase()] = headerValue;
  }
  const headerContentType = headers["content-type"];
  const headerMediaType = headerContentType
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (headerContentType !== undefined && headerMediaType !== contentType) {
    throw new LlmFetchError(
      "UPSTREAM_HTTP",
      "Fetcher returned a content-type header that conflicts with its response metadata.",
      { url: requestedUrl },
    );
  }
  if (!READABLE_CONTENT_TYPES.has(contentType)) {
    throw new LlmFetchError(
      "UNSUPPORTED_CONTENT_TYPE",
      `Unsupported content type: ${contentType}.`,
      { url: requestedUrl },
    );
  }
  return {
    requestedUrl: normalizedRequestedUrl,
    finalUrl: normalizedFinalUrl,
    status: result.status as number,
    contentType,
    body: result.body,
    headers,
    fetchMethod: result.fetchMethod,
    ...(result.limitations === undefined
      ? {}
      : { limitations: [...result.limitations] }),
  };
}
