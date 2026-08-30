import type {
  ReadInput,
  RetrievedDocument,
  SearchAndReadInput,
  SearchAndReadResult,
  SearchHit,
  SearchInput,
} from "./contracts.js";
import { LlmFetchError, toLlmFetchError } from "./errors.js";
import { abortReason } from "./internal/abort-signal.js";
import { createDeadline } from "./internal/deadline.js";
import { Semaphore } from "./internal/semaphore.js";
import {
  RENDER_MODES,
  integerInRange,
  isTimeoutReason,
  normalizeSearchInput,
  optionalRequestedUse,
  timeoutError,
} from "./client-validation.js";

interface SearchAndReadDependencies {
  assertOpen(): void;
  isClosed(): boolean;
  search(input: SearchInput): Promise<SearchHit[]>;
  read(input: ReadInput): Promise<RetrievedDocument>;
  timeoutMs: number;
}

export function createSearchAndRead({
  assertOpen,
  isClosed,
  search,
  read,
  timeoutMs,
}: SearchAndReadDependencies): (
  input: SearchAndReadInput,
) => Promise<SearchAndReadResult> {
  return async function searchAndRead(
    input: SearchAndReadInput,
  ): Promise<SearchAndReadResult> {
    assertOpen();
    const startedAt = performance.now();
    const normalizedSearch = normalizeSearchInput(input);
    const concurrency = input.concurrency ?? 4;
    integerInRange(concurrency, "concurrency", 1, 16);
    const perHostConcurrency =
      input.perHostConcurrency ?? Math.min(2, concurrency);
    integerInRange(perHostConcurrency, "perHostConcurrency", 1, concurrency);
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
    const deadline = createDeadline(timeoutMs);
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
            if (isClosed()) assertOpen();
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
      if (normalizedSearch.signal?.aborted) {
        throw abortReason(normalizedSearch.signal);
      }
      if (signal.aborted && isTimeoutReason(signal.reason)) {
        throw timeoutError(
          "Search and read exceeded its deadline.",
          undefined,
          error,
        );
      }
      throw error;
    }
  };
}
