import type { SearchHit, SearchInput, SearchProvider } from "../contracts.js";
import { LlmFetchError, toLlmFetchError } from "../errors.js";
import {
  abortReason,
  isAbortSignal,
  waitWithSignal,
} from "../internal/abort-signal.js";
import { createDeadline } from "../internal/deadline.js";
import { readResponseBytes } from "../internal/read-response.js";
import {
  deduplicateSearchUrls,
  normalizeResultUrl,
} from "../retrieval/url-normalizer.js";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export interface BraveOptions {
  apiKey: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof globalThis.fetch;
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      `${name} must be an integer between 1 and ${maximum}.`,
      { provider: "brave" },
    );
  }
  return value;
}

function discardBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation) void cancellation.catch(() => undefined);
  } catch {
    // The body may already be closed by the fetch implementation.
  }
}

interface BraveResult {
  title?: unknown;
  url?: unknown;
  description?: unknown;
}

function resultArray(value: unknown): BraveResult[] | null {
  if (!value || typeof value !== "object") return null;
  const web = Reflect.get(value, "web");
  if (!web || typeof web !== "object") return null;
  const results = Reflect.get(web, "results");
  return Array.isArray(results)
    ? results.filter(
        (item): item is BraveResult =>
          item !== null && typeof item === "object",
      )
    : null;
}

function validateInput(input: SearchInput): { query: string; limit: number } {
  if (!input || typeof input !== "object" || typeof input.query !== "string") {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "Search input and query are required.",
      {
        provider: "brave",
      },
    );
  }
  const query = input.query.trim();
  const limit = input.limit ?? 10;
  if (!query || query.length > 400 || query.split(/\s+/u).length > 50) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "Brave Search query must contain at most 400 characters and 50 words.",
      { provider: "brave" },
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "Search limit must be an integer between 1 and 20.",
      { provider: "brave" },
    );
  }
  if (
    input.safeSearch !== undefined &&
    !(["strict", "moderate", "off"] as const).includes(input.safeSearch)
  ) {
    throw new LlmFetchError("INVALID_INPUT", "safeSearch is invalid.", {
      provider: "brave",
    });
  }
  if (
    input.timeRange !== undefined &&
    !(["day", "week", "month", "year"] as const).includes(input.timeRange)
  ) {
    throw new LlmFetchError("INVALID_INPUT", "timeRange is invalid.", {
      provider: "brave",
    });
  }
  if (
    input.locale !== undefined &&
    (typeof input.locale !== "string" ||
      !input.locale.trim() ||
      input.locale.length > 100)
  ) {
    throw new LlmFetchError("INVALID_INPUT", "locale is invalid.", {
      provider: "brave",
    });
  }
  if (input.signal !== undefined && !isAbortSignal(input.signal)) {
    throw new LlmFetchError("INVALID_INPUT", "signal must be an AbortSignal.", {
      provider: "brave",
    });
  }
  input.signal?.throwIfAborted();
  return { query, limit };
}

function freshness(value: SearchInput["timeRange"]): string | undefined {
  switch (value) {
    case "day":
      return "pd";
    case "week":
      return "pw";
    case "month":
      return "pm";
    case "year":
      return "py";
    case undefined:
      return undefined;
  }
}

export function brave(options: BraveOptions): SearchProvider {
  const apiKey = options?.apiKey?.trim();
  if (!apiKey || apiKey.length > 512 || /[\r\n]/.test(apiKey)) {
    throw new LlmFetchError(
      "CONFIG_MISSING",
      "A valid Brave Search API key is required.",
      { provider: "brave" },
    );
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new LlmFetchError(
      "CONFIG_MISSING",
      "A Fetch implementation is required.",
      {
        provider: "brave",
      },
    );
  }
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? 5_000,
    "timeoutMs",
    300_000,
  );
  const maxResponseBytes = positiveInteger(
    options.maxResponseBytes ?? 1_000_000,
    "maxResponseBytes",
    10_000_000,
  );
  let rateLimitedUntil = 0;

  return {
    name: "brave",
    async search(input: SearchInput): Promise<SearchHit[]> {
      const { query, limit } = validateInput(input);
      const cooldownMs = Math.ceil(rateLimitedUntil - Date.now());
      if (cooldownMs > 0) {
        throw new LlmFetchError(
          "RATE_LIMITED",
          "Brave Search is temporarily paused after an upstream rate limit.",
          {
            provider: "brave",
            retryable: true,
            cooldownMs,
          },
        );
      }
      const searchParams = new URLSearchParams({
        q: query,
        count: String(limit),
        safesearch: input.safeSearch ?? "moderate",
      });
      if (input.locale) searchParams.set("search_lang", input.locale.trim());
      const freshnessValue = freshness(input.timeRange);
      if (freshnessValue) searchParams.set("freshness", freshnessValue);
      const url = new URL(BRAVE_SEARCH_ENDPOINT);
      url.search = searchParams.toString();
      const deadline = createDeadline(timeoutMs);
      const signal = deadline.signal(input.signal);

      let response: Response;
      try {
        response = await waitWithSignal(
          fetchImpl(url, {
            method: "GET",
            redirect: "error",
            signal,
            headers: {
              accept: "application/json",
              "x-subscription-token": apiKey,
              "user-agent": "llm-fetch/0.1",
            },
          }),
          signal,
        );
      } catch (error) {
        if (input.signal?.aborted) throw abortReason(input.signal);
        if (
          deadline.remainingMs() <= 0 ||
          (error instanceof Error && error.name === "TimeoutError")
        ) {
          throw new LlmFetchError(
            "TIMEOUT",
            "Brave Search request timed out.",
            {
              provider: "brave",
              retryable: true,
              cause: error,
            },
          );
        }
        throw toLlmFetchError(error, {
          code: "UPSTREAM_HTTP",
          message: "Brave Search request failed.",
          provider: "brave",
          retryable: true,
        });
      }

      if (response.status === 429) {
        discardBody(response);
        rateLimitedUntil = Date.now() + 60_000;
        throw new LlmFetchError(
          "RATE_LIMITED",
          "Brave Search rate limited the request.",
          {
            provider: "brave",
            status: 429,
            retryable: true,
            cooldownMs: 60_000,
          },
        );
      }
      if (!response.ok) {
        discardBody(response);
        throw new LlmFetchError(
          "UPSTREAM_HTTP",
          `Brave Search returned HTTP ${response.status}.`,
          {
            provider: "brave",
            status: response.status,
            retryable: response.status >= 500,
          },
        );
      }

      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (contentType && contentType !== "application/json") {
        discardBody(response);
        throw new LlmFetchError(
          "PARSE_CHANGED",
          "Brave Search returned a non-JSON response.",
          {
            provider: "brave",
            retryable: true,
          },
        );
      }
      let bytes: Uint8Array;
      try {
        bytes = await readResponseBytes(response, maxResponseBytes, signal);
      } catch (error) {
        if (error instanceof LlmFetchError) throw error;
        if (input.signal?.aborted) throw abortReason(input.signal);
        if (
          deadline.remainingMs() <= 0 ||
          (error instanceof Error && error.name === "TimeoutError")
        ) {
          throw new LlmFetchError(
            "TIMEOUT",
            "Brave Search request timed out.",
            {
              provider: "brave",
              retryable: true,
              cause: error,
            },
          );
        }
        throw toLlmFetchError(error, {
          code: "UPSTREAM_HTTP",
          message: "Brave Search response failed.",
          provider: "brave",
          retryable: true,
        });
      }
      let data: unknown;
      try {
        data = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      } catch (error) {
        throw new LlmFetchError(
          "PARSE_CHANGED",
          "Brave Search returned invalid JSON.",
          {
            provider: "brave",
            retryable: true,
            cause: error,
          },
        );
      }

      const parsedResults = resultArray(data);
      if (!parsedResults) {
        throw new LlmFetchError(
          "PARSE_CHANGED",
          "Brave Search response shape changed.",
          {
            provider: "brave",
            retryable: true,
          },
        );
      }
      const hits: SearchHit[] = [];
      for (const result of parsedResults) {
        const title =
          typeof result.title === "string" ? result.title.trim() : "";
        const rawUrl = typeof result.url === "string" ? result.url : "";
        const urlValue =
          rawUrl.length <= 2_048 ? normalizeResultUrl(rawUrl) : null;
        if (!title || !urlValue) continue;
        hits.push({
          provider: "brave",
          rank: hits.length + 1,
          title: title.slice(0, 1_000),
          url: urlValue,
          snippet:
            typeof result.description === "string"
              ? result.description.trim().slice(0, 10_000)
              : "",
        });
        if (hits.length >= limit) break;
      }
      return deduplicateSearchUrls(hits).map((hit, index) => ({
        ...hit,
        rank: index + 1,
      }));
    },
  };
}
