import type {
  ContentGuard,
  GuardResult,
  ReadInput,
  RetrievedDocument,
  SearchAndReadInput,
  SearchAndReadResult,
  SearchHit,
  SearchInput,
  SearchProvider,
  SearchProviderHit,
  SourceMetadata,
} from "./contracts.js";
import { isIP } from "node:net";
import { LlmFetchError, toLlmFetchError } from "./errors.js";
import {
  abortReason,
  isAbortSignal,
  waitWithSignal,
} from "./internal/abort-signal.js";
import {
  createDeadline,
  throwIfDeadlineElapsed,
  type Deadline,
} from "./internal/deadline.js";
import { InFlightMap } from "./internal/in-flight.js";
import { LruCache } from "./internal/lru-cache.js";
import { Semaphore } from "./internal/semaphore.js";
import {
  decodeBody,
  extractHtmlContent,
  extractPlainTextContent,
  loadHtml,
  loadXml,
  type ExtractedContent,
} from "./retrieval/extract-content.js";
import {
  httpContentRetriever,
  type ContentRetrievalResult,
  type ContentRetriever,
} from "./retrieval/content-retriever.js";
import { isLikelyDynamicHtml } from "./retrieval/dynamic-content.js";
import {
  createSafeHttpFetcher,
  type SafeHttpFetcher,
  type SafeHttpFetcherOptions,
} from "./retrieval/http-fetcher.js";
import { normalizeResultUrl } from "./retrieval/url-normalizer.js";
import { isPublicIpAddress } from "./retrieval/outbound-policy.js";
import {
  createInternalBuiltinContextGuard,
  runAdditionalGuard,
  type BuiltinContextGuardOptions,
} from "./security/context-guard.js";
import { mergeGuardResults } from "./security/merge-decisions.js";
import type { ContentSegment } from "./security/html-segments.js";
import { createToolset, type LlmFetchToolset } from "./tools/toolset.js";

type CachedDocument = Omit<RetrievedDocument, "source">;
const REQUESTED_USES = new Set([
  "summarize",
  "answer_with_citation",
  "extract_facts",
  "search_more",
  "call_readonly_tool",
]);
const SAFE_SEARCH_VALUES = new Set(["strict", "moderate", "off"]);
const TIME_RANGES = new Set(["day", "week", "month", "year"]);
const RENDER_MODES = new Set(["never", "auto", "always"]);
const READABLE_CONTENT_TYPES = new Set([
  "text/html",
  "text/plain",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
]);

export interface LlmFetchOptions {
  search?: SearchProvider;
  retrieval?: SafeHttpFetcherOptions;
  contextGuard?: BuiltinContextGuardOptions;
  additionalGuard?: ContentGuard;
  cache?: {
    enabled?: boolean;
    maxEntries?: number;
    searchTtlMs?: number;
    documentTtlMs?: number;
  };
  searchTimeoutMs?: number;
  readTimeoutMs?: number;
  searchAndReadTimeoutMs?: number;
  additionalGuardTimeoutMs?: number;
  fetcher?: SafeHttpFetcher;
  browser?: {
    retriever: ContentRetriever;
    defaultRender?: "never" | "auto" | "always";
  };
}

export interface LlmFetchClient {
  search(input: SearchInput): Promise<SearchHit[]>;
  read(input: ReadInput): Promise<RetrievedDocument>;
  searchAndRead(input: SearchAndReadInput): Promise<SearchAndReadResult>;
  toolset(): LlmFetchToolset;
  close(): Promise<void>;
}

function searchCacheKey(provider: string, input: SearchInput): string {
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

function hasControlCharacters(value: string): boolean {
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

function integerInRange(
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

function optionalRequestedUse(value: unknown): ReadInput["requestedUse"] {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !REQUESTED_USES.has(value)) {
    throw new LlmFetchError("INVALID_INPUT", "requestedUse is invalid.");
  }
  return value as NonNullable<ReadInput["requestedUse"]>;
}

function normalizeSearchInput(input: SearchInput): SearchInput {
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

function normalizeReadInput(input: ReadInput): ReadInput {
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

function normalizeSearchHits(
  value: unknown,
  provider: string,
  limit: number,
): SearchHit[] {
  if (!Array.isArray(value)) {
    throw new LlmFetchError(
      "PARSE_CHANGED",
      "Search provider returned a non-array result.",
      {
        provider,
      },
    );
  }
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  if (value.length > 1_000) {
    throw new LlmFetchError(
      "PARSE_CHANGED",
      "Search provider returned too many results.",
      {
        provider,
      },
    );
  }
  for (const item of value) {
    if (!item || typeof item !== "object") {
      throw new LlmFetchError(
        "PARSE_CHANGED",
        "Search provider returned an invalid result.",
        {
          provider,
        },
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
        {
          provider,
        },
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
        {
          provider,
        },
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

function validateNonNegativeInteger(
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

function isTimeoutReason(value: unknown): boolean {
  return value instanceof DOMException && value.name === "TimeoutError";
}

function timeoutError(
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

function validateFetchResult(
  value: unknown,
  requestedUrl: string,
): ContentRetrievalResult {
  if (!value || typeof value !== "object") {
    throw new LlmFetchError(
      "UPSTREAM_HTTP",
      "Fetcher returned an invalid response.",
      {
        url: requestedUrl,
      },
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
      {
        url: requestedUrl,
      },
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
      {
        url: requestedUrl,
      },
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
        {
          url: requestedUrl,
        },
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

function cloneHits(hits: readonly SearchHit[]): SearchHit[] {
  return hits.map((hit) => ({ ...hit }));
}

function sourceMetadata(
  input: ReadInput,
  finalUrl: string,
  fetchedAt: string,
): SourceMetadata {
  const source: SourceMetadata = {
    kind: "web",
    trust: "untrusted",
    url: input.url,
    finalUrl,
    retrievedAt: fetchedAt,
  };
  if (input.source) {
    source.provider = input.source.provider;
    source.query = input.source.query;
    source.rank = input.source.rank;
    if (input.source.snippet !== undefined)
      source.snippet = input.source.snippet;
  }
  return source;
}

function documentWithSource(
  document: CachedDocument,
  source: ReadInput["source"],
): RetrievedDocument {
  const result: RetrievedDocument = {
    ...document,
    security: {
      ...document.security,
      findings: document.security.findings.map((finding) => ({
        ...finding,
        techniques: [...finding.techniques],
      })),
      reasons: [...document.security.reasons],
      limitations: [...document.security.limitations],
    },
  };
  if (source) result.source = { ...source };
  return result;
}

export function createLlmFetch(options: LlmFetchOptions): LlmFetchClient {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new LlmFetchError("INVALID_INPUT", "Client options must be an object.");
  }
  if (
    options.search !== undefined &&
    (!options.search ||
      typeof options.search !== "object" ||
      Array.isArray(options.search) ||
      typeof options.search.name !== "string" ||
      !options.search.name.trim() ||
      options.search.name.length > 500 ||
      hasControlCharacters(options.search.name) ||
      typeof options.search.search !== "function")
  ) {
    throw new LlmFetchError("INVALID_INPUT", "The search provider is invalid.");
  }

  if (
    options.cache !== undefined &&
    (!options.cache ||
      typeof options.cache !== "object" ||
      Array.isArray(options.cache))
  ) {
    throw new LlmFetchError("INVALID_INPUT", "cache must be an object.");
  }

  if (options.fetcher !== undefined && typeof options.fetcher !== "function") {
    throw new LlmFetchError("INVALID_INPUT", "fetcher must be a function.");
  }
  const allowedContentTypes = options.retrieval?.allowedContentTypes;
  if (
    allowedContentTypes !== undefined &&
    (!Array.isArray(allowedContentTypes) ||
      allowedContentTypes.some(
        (contentType) =>
          typeof contentType !== "string" ||
          !READABLE_CONTENT_TYPES.has(contentType.trim().toLowerCase()),
      ))
  ) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "retrieval.allowedContentTypes contains a type the client cannot extract.",
    );
  }
  if (options.browser !== undefined) {
    if (
      !options.browser ||
      typeof options.browser !== "object" ||
      Array.isArray(options.browser) ||
      !options.browser.retriever ||
      typeof options.browser.retriever !== "object" ||
      typeof options.browser.retriever.name !== "string" ||
      !options.browser.retriever.name.trim() ||
      options.browser.retriever.name.length > 100 ||
      hasControlCharacters(options.browser.retriever.name) ||
      typeof options.browser.retriever.retrieve !== "function" ||
      (options.browser.retriever.isAvailable !== undefined &&
        typeof options.browser.retriever.isAvailable !== "function") ||
      (options.browser.retriever.close !== undefined &&
        typeof options.browser.retriever.close !== "function")
    ) {
      throw new LlmFetchError("INVALID_INPUT", "browser.retriever is invalid.");
    }
    if (
      options.browser.defaultRender !== undefined &&
      !RENDER_MODES.has(options.browser.defaultRender)
    ) {
      throw new LlmFetchError(
        "INVALID_INPUT",
        "browser.defaultRender is invalid.",
      );
    }
  }
  if (
    options.additionalGuard !== undefined &&
    (!options.additionalGuard ||
      typeof options.additionalGuard.inspect !== "function" ||
      (options.additionalGuard.name !== undefined &&
        (typeof options.additionalGuard.name !== "string" ||
          !options.additionalGuard.name.trim() ||
          options.additionalGuard.name.length > 100 ||
          hasControlCharacters(options.additionalGuard.name))))
  ) {
    throw new LlmFetchError("INVALID_INPUT", "additionalGuard is invalid.");
  }

  const cacheEnabled = options.cache?.enabled ?? true;
  if (typeof cacheEnabled !== "boolean") {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "cache.enabled must be a boolean.",
    );
  }
  const maxEntries = validateNonNegativeInteger(
    options.cache?.maxEntries ?? 100,
    "cache.maxEntries",
    10_000,
  );
  const searchTtlMs = validateNonNegativeInteger(
    options.cache?.searchTtlMs ?? 30_000,
    "cache.searchTtlMs",
    86_400_000,
  );
  const documentTtlMs = validateNonNegativeInteger(
    options.cache?.documentTtlMs ?? 60_000,
    "cache.documentTtlMs",
    86_400_000,
  );
  const searchAndReadTimeoutMs = integerInRange(
    options.searchAndReadTimeoutMs ?? 15_000,
    "searchAndReadTimeoutMs",
    1,
    300_000,
  );
  const searchTimeoutMs = integerInRange(
    options.searchTimeoutMs ?? 10_000,
    "searchTimeoutMs",
    1,
    300_000,
  );
  const readTimeoutMs = integerInRange(
    options.readTimeoutMs ?? 15_000,
    "readTimeoutMs",
    1,
    300_000,
  );
  const additionalGuardTimeoutMs = integerInRange(
    options.additionalGuardTimeoutMs ?? 5_000,
    "additionalGuardTimeoutMs",
    1,
    300_000,
  );
  const httpRetriever = httpContentRetriever(
    options.fetcher ?? createSafeHttpFetcher(options.retrieval),
  );
  const browserRetriever = options.browser?.retriever;
  const defaultRender =
    options.browser?.defaultRender ?? (browserRetriever ? "auto" : "never");
  const builtinGuard = createInternalBuiltinContextGuard(options.contextGuard);
  const additionalGuard = options.additionalGuard;
  const searchProvider = options.search;
  const searchCache = new LruCache<SearchHit[]>(cacheEnabled ? maxEntries : 0);
  const documentCache = new LruCache<CachedDocument>(
    cacheEnabled ? maxEntries : 0,
  );
  const searchInflight = new InFlightMap<SearchHit[]>();
  const readInflight = new InFlightMap<CachedDocument>();
  let closed = false;
  let closePromise: Promise<void> | undefined;

  function assertOpen(): void {
    if (closed) {
      throw new LlmFetchError(
        "CONFIG_MISSING",
        "The llm-fetch client is closed.",
      );
    }
  }

  async function runConfiguredGuard(
    input: Parameters<ContentGuard["inspect"]>[0],
  ): Promise<GuardResult> {
    if (!additionalGuard) {
      throw new LlmFetchError(
        "GUARD_FAILED",
        "No additional guard is configured.",
      );
    }
    const timeoutSignal = AbortSignal.timeout(additionalGuardTimeoutMs);
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeoutSignal])
      : timeoutSignal;
    return waitWithSignal(
      runAdditionalGuard(additionalGuard, { ...input, signal }),
      signal,
    );
  }

  async function search(input: SearchInput): Promise<SearchHit[]> {
    assertOpen();
    if (!searchProvider) {
      throw new LlmFetchError(
        "CONFIG_MISSING",
        "A search provider is required for search operations.",
      );
    }
    const normalizedInput = normalizeSearchInput(input);
    normalizedInput.signal?.throwIfAborted();
    const key = searchCacheKey(searchProvider.name, normalizedInput);
    const cached = searchCache.get(key);
    if (cached) return cloneHits(cached);

    const loadHits = async (sharedSignal: AbortSignal) => {
      const deadline = createDeadline(searchTimeoutMs);
      const signal = deadline.signal(sharedSignal);
      signal.throwIfAborted();
      let rawResult: SearchProviderHit[];
      try {
        rawResult = await waitWithSignal(
          searchProvider.search({
            ...normalizedInput,
            signal,
          }),
          signal,
        );
      } catch (error) {
        if (error instanceof LlmFetchError) throw error;
        if (signal.aborted && isTimeoutReason(signal.reason)) {
          throw timeoutError("Search exceeded its deadline.", undefined, error);
        }
        if (sharedSignal.aborted) throw abortReason(sharedSignal);
        throw toLlmFetchError(error, {
          code: "UPSTREAM_HTTP",
          message: "Search provider failed.",
          provider: searchProvider.name,
        });
      }
      try {
        signal.throwIfAborted();
      } catch (error) {
        if (isTimeoutReason(signal.reason)) {
          throw timeoutError("Search exceeded its deadline.", undefined, error);
        }
        throw error;
      }
      const result = normalizeSearchHits(
        rawResult,
        searchProvider.name,
        normalizedInput.limit ?? 10,
      );
      searchCache.set(key, cloneHits(result), searchTtlMs);
      return result;
    };
    const hits = await searchInflight.run(
      key,
      loadHits,
      normalizedInput.signal,
    );
    return cloneHits(hits);
  }

  async function inspectSearchResults(hits: SearchHit[], query: string) {
    const inspected = await Promise.all(
      hits.map(async (hit) => {
        const builtinResult = builtinGuard.inspectPrepared({
          visibleText: `${hit.provider}\n${hit.title}\n${hit.snippet}\n${hit.url}\n${hit.displayUrl ?? ""}`,
          requestedUse: "answer_with_citation",
        });
        let result = builtinResult;
        if (additionalGuard) {
          const source: SourceMetadata = {
            kind: "search_result",
            trust: "untrusted",
            url: hit.url,
            provider: hit.provider,
            query,
            rank: hit.rank,
            snippet: hit.snippet,
          };
          try {
            const extra = await runConfiguredGuard({
              rawBody: new TextEncoder().encode(
                `${hit.provider}\n${hit.title}\n${hit.snippet}\n${hit.url}\n${hit.displayUrl ?? ""}`,
              ),
              contentType: "text/plain",
              source,
              requestedUse: "answer_with_citation",
            });
            result = mergeGuardResults([builtinResult, extra]);
          } catch {
            throw new LlmFetchError(
              "GUARD_FAILED",
              "Search result guard failed.",
              {
                url: hit.url,
              },
            );
          }
        }
        return { hit, result };
      }),
    );

    const allowed = inspected
      .filter(
        ({ result }) =>
          result.decision !== "deny" && result.decision !== "require_approval",
      )
      .map(({ hit }) => hit);
    const results = inspected.map(({ result }) => result);
    const blockedResultCount = hits.length - allowed.length;

    let guard =
      results.length > 0
        ? mergeGuardResults(results)
        : builtinGuard.inspectPrepared({
            visibleText: "",
            requestedUse: "answer_with_citation",
          });
    if (blockedResultCount > 0) {
      guard = {
        ...guard,
        decision: allowed.length === 0 ? "deny" : "allow_with_warning",
        reasons: [
          ...new Set([
            ...guard.reasons,
            `${blockedResultCount} search result(s) were withheld by the context guard.`,
          ]),
        ],
      };
    }
    return { hits: allowed, blockedResultCount, guard };
  }

  async function inspectAdditional(
    input: ReadInput,
    fetched: ContentRetrievalResult,
    source: SourceMetadata,
  ): Promise<GuardResult | undefined> {
    if (!additionalGuard) return undefined;
    const guardInput: Parameters<ContentGuard["inspect"]>[0] = {
      rawBody: fetched.body,
      contentType: fetched.contentType,
      source,
      requestedUse: input.requestedUse ?? "answer_with_citation",
    };
    if (input.signal) guardInput.signal = input.signal;
    try {
      return await runConfiguredGuard(guardInput);
    } catch {
      if (input.signal?.aborted) throw abortReason(input.signal);
      throw new LlmFetchError(
        "GUARD_FAILED",
        "Additional content guard failed.",
        {
          url: fetched.finalUrl,
        },
      );
    }
  }

  async function retrieveWith(
    retriever: ContentRetriever,
    expectedMethod: ContentRetrievalResult["fetchMethod"],
    normalizedUrl: string,
    signal: AbortSignal | undefined,
  ): Promise<ContentRetrievalResult> {
    const retrievalInput = signal ? { signal } : {};
    try {
      signal?.throwIfAborted();
      const retrieval = retriever.retrieve(normalizedUrl, retrievalInput);
      const result = validateFetchResult(
        await (signal ? waitWithSignal(retrieval, signal) : retrieval),
        normalizedUrl,
      );
      if (result.fetchMethod !== expectedMethod) {
        throw new LlmFetchError(
          "UPSTREAM_HTTP",
          `${retriever.name} returned an unexpected retrieval method.`,
          { url: normalizedUrl },
        );
      }
      return result;
    } catch (error) {
      if (error instanceof LlmFetchError) throw error;
      if (signal?.aborted) throw abortReason(signal);
      throw toLlmFetchError(error, {
        code: "UPSTREAM_HTTP",
        message: `${retriever.name} content retrieval failed.`,
        url: normalizedUrl,
        retryable: true,
      });
    }
  }

  async function processFetched(
    input: ReadInput,
    normalizedUrl: string,
    fetched: ContentRetrievalResult,
    deadline: Deadline,
  ): Promise<CachedDocument> {
    input.signal?.throwIfAborted();
    throwIfDeadlineElapsed(deadline);
    const fetchedAt = new Date().toISOString();
    const source = sourceMetadata(input, fetched.finalUrl, fetchedAt);
    const contentTypeHeader =
      fetched.headers["content-type"] ?? fetched.contentType;
    const decoded = decodeBody(fetched.body, contentTypeHeader);
    throwIfDeadlineElapsed(deadline);
    const requestedUse = input.requestedUse ?? "answer_with_citation";
    const referenceSegments: ContentSegment[] = [
      {
        location: "attribute",
        text: normalizedUrl,
        truncated: false,
        originalLength: normalizedUrl.length,
      },
      {
        location: "attribute",
        text: fetched.finalUrl,
        truncated: false,
        originalLength: fetched.finalUrl.length,
      },
    ];
    if (input.source?.provider) {
      referenceSegments.push({
        location: "attribute",
        text: input.source.provider,
        truncated: false,
        originalLength: input.source.provider.length,
      });
    }
    if (input.source?.snippet) {
      referenceSegments.push({
        location: "attribute",
        text: input.source.snippet,
        truncated: false,
        originalLength: input.source.snippet.length,
      });
    }

    const referenceResult = builtinGuard.inspectPrepared({
      visibleText: "",
      additionalSegments: referenceSegments,
      requestedUse,
    });
    let extracted: ExtractedContent | undefined;
    let extractionError: LlmFetchError | undefined;
    let contentResult: GuardResult;
    if (
      fetched.contentType === "text/html" ||
      fetched.contentType === "application/xhtml+xml"
    ) {
      const $ = loadHtml(decoded);
      throwIfDeadlineElapsed(deadline);
      const likelyDynamic =
        fetched.fetchMethod === "http" && isLikelyDynamicHtml($, decoded);
      throwIfDeadlineElapsed(deadline);
      const prepared = builtinGuard.prepareHtml($, decoded);
      throwIfDeadlineElapsed(deadline);
      const extractOptions =
        input.maxCharacters === undefined
          ? {}
          : { maxCharacters: input.maxCharacters };
      try {
        extracted = extractHtmlContent($, fetched.finalUrl, extractOptions);
        throwIfDeadlineElapsed(deadline);
        if (likelyDynamic && extracted.characterCount < 500) {
          throw new LlmFetchError(
            "CONTENT_INSUFFICIENT",
            "The page appears to require JavaScript rendering.",
            { url: fetched.finalUrl },
          );
        }
      } catch (error) {
        if (
          !(error instanceof LlmFetchError) ||
          error.code !== "CONTENT_INSUFFICIENT"
        ) {
          throw error;
        }
        extractionError = error;
      }
      contentResult = builtinGuard.inspectPrepared({
        visibleText: extracted
          ? `${extracted.title}\n${extracted.text}`
          : $("body").text(),
        additionalSegments: prepared.segments,
        requestedUse,
        truncated: prepared.truncated,
        truncationReasons:
          prepared.omittedSegments > 0
            ? [
                `${prepared.omittedSegments} content segment(s) were omitted by the collection limit.`,
              ]
            : [],
      });
      throwIfDeadlineElapsed(deadline);
    } else if (
      fetched.contentType === "application/xml" ||
      fetched.contentType === "text/xml"
    ) {
      const $ = loadXml(decoded);
      throwIfDeadlineElapsed(deadline);
      const visibleText = $.root().text();
      const extractOptions =
        input.maxCharacters === undefined
          ? {}
          : { maxCharacters: input.maxCharacters };
      extracted = extractPlainTextContent(
        visibleText,
        fetched.finalUrl,
        extractOptions,
      );
      contentResult = builtinGuard.inspectPrepared({
        visibleText: extracted.text,
        requestedUse,
      });
      throwIfDeadlineElapsed(deadline);
    } else {
      const extractOptions =
        input.maxCharacters === undefined
          ? {}
          : { maxCharacters: input.maxCharacters };
      extracted = extractPlainTextContent(
        decoded,
        fetched.finalUrl,
        extractOptions,
      );
      contentResult = builtinGuard.inspectPrepared({
        visibleText: extracted.text,
        requestedUse,
      });
      throwIfDeadlineElapsed(deadline);
    }

    let builtinResult = mergeGuardResults([referenceResult, contentResult]);
    if (fetched.fetchMethod === "playwright") {
      builtinResult = {
        ...builtinResult,
        limitations: builtinResult.limitations.filter(
          (limitation) =>
            limitation !==
            "External stylesheets and computed CSS visibility are not evaluated.",
        ),
      };
    }
    const extraResult = await inspectAdditional(input, fetched, source);
    throwIfDeadlineElapsed(deadline);
    const guardResult = extraResult
      ? mergeGuardResults([builtinResult, extraResult])
      : builtinResult;
    input.signal?.throwIfAborted();
    if (
      guardResult.decision === "deny" ||
      guardResult.decision === "require_approval"
    ) {
      throw new LlmFetchError(
        "GUARD_DENIED",
        "Retrieved content was withheld by the context guard.",
        {
          url: fetched.finalUrl,
          guardDecision: guardResult.decision,
          warningCategories: guardResult.findings
            .filter((finding) => finding.category !== "benign_mention")
            .map((finding) => finding.category),
        },
      );
    }
    if (extractionError) throw extractionError;
    if (!extracted) {
      throw new LlmFetchError(
        "CONTENT_INSUFFICIENT",
        "No readable content was extracted.",
        {
          url: fetched.finalUrl,
        },
      );
    }

    const transportLimitations = fetched.limitations ?? [];
    const limitations = [
      ...new Set([...guardResult.limitations, ...transportLimitations]),
    ];
    const assurance =
      fetched.fetchMethod === "playwright" && guardResult.assurance === "high"
        ? "medium"
        : guardResult.assurance;

    const document: CachedDocument = {
      url: normalizedUrl,
      finalUrl: fetched.finalUrl,
      title: extracted.title,
      text: extracted.text,
      contentType: fetched.contentType,
      fetchedAt,
      fetchMethod: fetched.fetchMethod,
      characterCount: extracted.characterCount,
      truncated: extracted.truncated,
      security: {
        trust: "untrusted",
        tainted: true,
        guard: additionalGuard?.name
          ? `builtin+${additionalGuard.name}`
          : "builtin",
        findings: guardResult.findings,
        assurance,
        decision: guardResult.decision,
        reasons: guardResult.reasons,
        limitations,
      },
    };
    if (extracted.excerpt !== undefined) document.excerpt = extracted.excerpt;
    return document;
  }

  async function browserIsAvailable(signal?: AbortSignal): Promise<boolean> {
    if (!browserRetriever) return false;
    if (!browserRetriever.isAvailable) return true;
    try {
      signal?.throwIfAborted();
      const availability = browserRetriever.isAvailable();
      const result = await (signal
        ? waitWithSignal(availability, signal)
        : availability);
      return result === true;
    } catch {
      if (signal?.aborted) throw abortReason(signal);
      return false;
    }
  }

  async function readUncached(
    input: ReadInput,
    deadline: Deadline,
  ): Promise<CachedDocument> {
    input.signal?.throwIfAborted();
    const normalizedUrl = normalizeResultUrl(input.url);
    if (!normalizedUrl) {
      throw new LlmFetchError(
        "INVALID_INPUT",
        "A valid HTTP or HTTPS URL is required.",
        {
          url: input.url,
        },
      );
    }
    const render = input.render ?? defaultRender;

    if (render === "always") {
      if (!browserRetriever) {
        throw new LlmFetchError(
          "CONFIG_MISSING",
          "Playwright retrieval is not configured.",
          { url: normalizedUrl },
        );
      }
      return processFetched(
        input,
        normalizedUrl,
        await retrieveWith(
          browserRetriever,
          "playwright",
          normalizedUrl,
          input.signal,
        ),
        deadline,
      );
    }

    const fetched = await retrieveWith(
      httpRetriever,
      "http",
      normalizedUrl,
      input.signal,
    );
    try {
      return await processFetched(input, normalizedUrl, fetched, deadline);
    } catch (error) {
      if (
        render !== "auto" ||
        !(error instanceof LlmFetchError) ||
        error.code !== "CONTENT_INSUFFICIENT" ||
        !browserRetriever ||
        !(await browserIsAvailable(input.signal))
      ) {
        throw error;
      }
      return processFetched(
        input,
        normalizedUrl,
        await retrieveWith(
          browserRetriever,
          "playwright",
          normalizedUrl,
          input.signal,
        ),
        deadline,
      );
    }
  }

  async function read(input: ReadInput): Promise<RetrievedDocument> {
    assertOpen();
    const normalizedInput = normalizeReadInput(input);
    normalizedInput.signal?.throwIfAborted();
    const normalizedUrl = normalizeResultUrl(normalizedInput.url);
    const key = JSON.stringify([
      normalizedUrl ?? normalizedInput.url,
      normalizedInput.maxCharacters ?? 20_000,
      normalizedInput.render ?? defaultRender,
      normalizedInput.requestedUse ?? "answer_with_citation",
      normalizedInput.source ?? null,
    ]);
    const cached = documentCache.get(key);
    if (cached) return documentWithSource(cached, normalizedInput.source);

    const loadDocument = async (sharedSignal: AbortSignal) => {
      const deadline = createDeadline(readTimeoutMs);
      const signal = deadline.signal(sharedSignal);
      try {
        const result = await readUncached(
          {
            ...normalizedInput,
            signal,
          },
          deadline,
        );
        signal.throwIfAborted();
        documentCache.set(key, result, documentTtlMs);
        return result;
      } catch (error) {
        if (signal.aborted && isTimeoutReason(signal.reason)) {
          throw timeoutError(
            "Content retrieval exceeded its deadline.",
            normalizedInput.url,
            error,
          );
        }
        if (error instanceof LlmFetchError) throw error;
        throw toLlmFetchError(error, {
          code: "CONTENT_INSUFFICIENT",
          message: "Retrieved content could not be processed safely.",
          url: normalizedInput.url,
        });
      }
    };
    const document = await readInflight.run(
      key,
      loadDocument,
      normalizedInput.signal,
    );
    return documentWithSource(document, normalizedInput.source);
  }

  async function searchAndRead(
    input: SearchAndReadInput,
  ): Promise<SearchAndReadResult> {
    assertOpen();
    const startedAt = performance.now();
    const normalizedSearch = normalizeSearchInput(input);
    const concurrency = input.concurrency ?? 4;
    integerInRange(concurrency, "concurrency", 1, 16);
    const perHostConcurrency =
      input.perHostConcurrency ?? Math.min(2, concurrency);
    integerInRange(
      perHostConcurrency,
      "perHostConcurrency",
      1,
      concurrency,
    );
    const maxCharactersPerDocument =
      input.maxCharactersPerDocument === undefined
        ? undefined
        : integerInRange(
            input.maxCharactersPerDocument,
            "maxCharactersPerDocument",
            200,
            100_000,
          );
    const requestedUse = optionalRequestedUse(input.requestedUse);
    if (
      input.render !== undefined &&
      (typeof input.render !== "string" || !RENDER_MODES.has(input.render))
    ) {
      throw new LlmFetchError("INVALID_INPUT", "render is invalid.");
    }
    const deadline = createDeadline(searchAndReadTimeoutMs);
    const signal = deadline.signal(normalizedSearch.signal);
    try {
      const hits = await search({ ...normalizedSearch, signal });
      const documents: RetrievedDocument[] = [];
      const failures: SearchAndReadResult["failures"] = [];
      const hostSemaphores = new Map<string, Semaphore>();
      let nextIndex = 0;
      let timedOut = false;

      const worker = async (): Promise<void> => {
        while (nextIndex < hits.length) {
          if (signal.aborted) {
            if (normalizedSearch.signal?.aborted) {
              throw abortReason(normalizedSearch.signal);
            }
            timedOut = true;
            return;
          }
          const index = nextIndex;
          nextIndex += 1;
          const hit = hits[index];
          if (!hit) return;
          const hostname = new URL(hit.url).hostname
            .toLowerCase()
            .replace(/\.$/u, "");
          let hostSemaphore = hostSemaphores.get(hostname);
          if (!hostSemaphore) {
            hostSemaphore = new Semaphore(perHostConcurrency);
            hostSemaphores.set(hostname, hostSemaphore);
          }
          let readStarted = false;
          try {
            await hostSemaphore.run(async () => {
              if (signal.aborted) throw abortReason(signal);
              readStarted = true;
              const readInput: ReadInput = {
                url: hit.url,
                signal,
                source: {
                  provider: hit.provider,
                  query: normalizedSearch.query,
                  rank: hit.rank,
                  snippet: hit.snippet,
                },
              };
              if (maxCharactersPerDocument !== undefined) {
                readInput.maxCharacters = maxCharactersPerDocument;
              }
              if (requestedUse !== undefined) {
                readInput.requestedUse = requestedUse;
              }
              if (input.render !== undefined) readInput.render = input.render;
              documents.push(await read(readInput));
            });
          } catch (error) {
            if (normalizedSearch.signal?.aborted) {
              throw abortReason(normalizedSearch.signal);
            }
            if (signal.aborted && isTimeoutReason(signal.reason)) {
              timedOut = true;
              failures.push({
                url: hit.url,
                kind: readStarted ? "overall_timeout" : "not_started",
                error: timeoutError(
                  readStarted
                    ? "Search and read exceeded its deadline while retrieving this result."
                    : "The result was not started before the overall deadline.",
                  hit.url,
                  error,
                ),
              });
              return;
            }
            if (closed) assertOpen();
            const normalizedError = toLlmFetchError(error, {
              message: "Failed to retrieve search result.",
              url: hit.url,
            });
            failures.push({
              url: hit.url,
              kind:
                normalizedError.code === "TIMEOUT"
                  ? "page_timeout"
                  : "page_failure",
              error: normalizedError,
            });
          }
        }
      };

      await Promise.all(
        Array.from(
          { length: Math.min(concurrency, hits.length) },
          async () => worker(),
        ),
      );
      if (signal.aborted && !normalizedSearch.signal?.aborted) timedOut = true;
      if (timedOut) {
        for (const hit of hits.slice(nextIndex)) {
          failures.push({
            url: hit.url,
            kind: "not_started",
            error: timeoutError(
              "The result was not started before the overall deadline.",
              hit.url,
            ),
          });
        }
      }
      documents.sort((a, b) => (a.source?.rank ?? 0) - (b.source?.rank ?? 0));
      const rankByUrl = new Map(hits.map((hit) => [hit.url, hit.rank]));
      failures.sort(
        (a, b) => (rankByUrl.get(a.url) ?? 0) - (rankByUrl.get(b.url) ?? 0),
      );

      return {
        hits,
        documents,
        failures,
        timedOut,
        durationMs: performance.now() - startedAt,
      };
    } catch (error) {
      if (normalizedSearch.signal?.aborted)
        throw abortReason(normalizedSearch.signal);
      if (signal.aborted && isTimeoutReason(signal.reason)) {
        throw timeoutError(
          "Search and read exceeded its deadline.",
          undefined,
          error,
        );
      }
      throw error;
    }
  }

  return {
    search,
    read,
    searchAndRead,
    toolset() {
      return createToolset(
        { search, read, inspectSearchResults },
        { search: searchProvider !== undefined },
      );
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        searchInflight.clear();
        readInflight.clear();
        searchCache.clear();
        documentCache.clear();
        await browserRetriever?.close?.();
      })();
      return closePromise;
    },
  };
}
