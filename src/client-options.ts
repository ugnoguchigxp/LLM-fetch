import type { ContentGuard, SearchProvider } from "./contracts.js";
import { LlmFetchError } from "./errors.js";
import type { ContentRetriever } from "./retrieval/content-retriever.js";
import type {
  SafeHttpFetcher,
  SafeHttpFetcherOptions,
} from "./retrieval/http-fetcher.js";
import type { BuiltinContextGuardOptions } from "./security/context-guard.js";
import {
  READABLE_CONTENT_TYPES,
  RENDER_MODES,
  hasControlCharacters,
  integerInRange,
  validateNonNegativeInteger,
} from "./client-validation.js";

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

export interface ValidatedClientOptions {
  cacheEnabled: boolean;
  maxEntries: number;
  searchTtlMs: number;
  documentTtlMs: number;
  searchAndReadTimeoutMs: number;
  searchTimeoutMs: number;
  readTimeoutMs: number;
  additionalGuardTimeoutMs: number;
  browserRetriever?: ContentRetriever;
  defaultRender: "never" | "auto" | "always";
  additionalGuard?: ContentGuard;
  searchProvider?: SearchProvider;
}

export function validateClientOptions(
  options: LlmFetchOptions,
): ValidatedClientOptions {
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
  const browserRetriever = options.browser?.retriever;
  const defaultRender =
    options.browser?.defaultRender ?? (browserRetriever ? "auto" : "never");
  return {
    cacheEnabled,
    maxEntries: validateNonNegativeInteger(
      options.cache?.maxEntries ?? 100,
      "cache.maxEntries",
      10_000,
    ),
    searchTtlMs: validateNonNegativeInteger(
      options.cache?.searchTtlMs ?? 30_000,
      "cache.searchTtlMs",
      86_400_000,
    ),
    documentTtlMs: validateNonNegativeInteger(
      options.cache?.documentTtlMs ?? 60_000,
      "cache.documentTtlMs",
      86_400_000,
    ),
    searchAndReadTimeoutMs: integerInRange(
      options.searchAndReadTimeoutMs ?? 15_000,
      "searchAndReadTimeoutMs",
      1,
      300_000,
    ),
    searchTimeoutMs: integerInRange(
      options.searchTimeoutMs ?? 10_000,
      "searchTimeoutMs",
      1,
      300_000,
    ),
    readTimeoutMs: integerInRange(
      options.readTimeoutMs ?? 15_000,
      "readTimeoutMs",
      1,
      300_000,
    ),
    additionalGuardTimeoutMs: integerInRange(
      options.additionalGuardTimeoutMs ?? 5_000,
      "additionalGuardTimeoutMs",
      1,
      300_000,
    ),
    ...(browserRetriever ? { browserRetriever } : {}),
    defaultRender,
    ...(options.additionalGuard
      ? { additionalGuard: options.additionalGuard }
      : {}),
    ...(options.search ? { searchProvider: options.search } : {}),
  };
}
