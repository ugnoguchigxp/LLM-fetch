import type { SafeFetchResult, SafeHttpFetcher } from "./http-fetcher.js";

export type FetchMethod = "http" | "playwright";

export interface ContentRetrievalResult extends SafeFetchResult {
  fetchMethod: FetchMethod;
  limitations?: readonly string[];
}

export interface ContentRetrieverInput {
  signal?: AbortSignal;
}

export interface ContentRetriever {
  readonly name: string;
  isAvailable?(): Promise<boolean>;
  retrieve(
    url: string,
    input?: ContentRetrieverInput,
  ): Promise<ContentRetrievalResult>;
  close?(): Promise<void>;
}

export function httpContentRetriever(fetcher: SafeHttpFetcher): ContentRetriever {
  return {
    name: "http",
    async retrieve(url, input = {}) {
      return {
        ...await fetcher(url, input),
        fetchMethod: "http",
      };
    },
  };
}
