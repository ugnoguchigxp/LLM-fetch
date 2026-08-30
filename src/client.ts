import type {
  ContentGuard,
  GuardResult,
  ReadInput,
  RetrievedDocument,
  SearchAndReadInput,
  SearchAndReadResult,
  SearchHit,
  SearchInput,
  SearchProviderHit,
  SourceMetadata,
} from "./contracts.js";
import { LlmFetchError, toLlmFetchError } from "./errors.js";
import {
  abortReason,
  waitWithSignal,
} from "./internal/abort-signal.js";
import {
  createDeadline,
  throwIfDeadlineElapsed,
  type Deadline,
} from "./internal/deadline.js";
import { InFlightMap } from "./internal/in-flight.js";
import { LruCache } from "./internal/lru-cache.js";
import { createSearchAndRead } from "./client-search-and-read.js";
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
} from "./retrieval/http-fetcher.js";
import { normalizeResultUrl } from "./retrieval/url-normalizer.js";
import {
  createInternalBuiltinContextGuard,
  runAdditionalGuard,
} from "./security/context-guard.js";
import { mergeGuardResults } from "./security/merge-decisions.js";
import type { ContentSegment } from "./security/html-segments.js";
import { createToolset, type LlmFetchToolset } from "./tools/toolset.js";
import {
  isTimeoutReason,
  normalizeReadInput,
  normalizeSearchHits,
  normalizeSearchInput,
  searchCacheKey,
  timeoutError,
  validateFetchResult,
} from "./client-validation.js";
import {
  validateClientOptions,
  type LlmFetchOptions,
} from "./client-options.js";

export type { LlmFetchOptions } from "./client-options.js";

type CachedDocument = Omit<RetrievedDocument, "source">;

export interface LlmFetchClient {
  search(input: SearchInput): Promise<SearchHit[]>;
  read(input: ReadInput): Promise<RetrievedDocument>;
  searchAndRead(input: SearchAndReadInput): Promise<SearchAndReadResult>;
  toolset(): LlmFetchToolset;
  close(): Promise<void>;
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
  const {
    cacheEnabled,
    maxEntries,
    searchTtlMs,
    documentTtlMs,
    searchAndReadTimeoutMs,
    searchTimeoutMs,
    readTimeoutMs,
    additionalGuardTimeoutMs,
    browserRetriever,
    defaultRender,
    additionalGuard,
    searchProvider,
  } = validateClientOptions(options);
  const httpRetriever = httpContentRetriever(
    options.fetcher ?? createSafeHttpFetcher(options.retrieval),
  );
  const builtinGuard = createInternalBuiltinContextGuard(options.contextGuard);
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

  const searchAndRead = createSearchAndRead({
    assertOpen,
    isClosed: () => closed,
    search,
    read,
    timeoutMs: searchAndReadTimeoutMs,
  });
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
