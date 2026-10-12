import type { SearchProvider, SearchProviderHit } from "../contracts.js";
import { hasControlCharacters, normalizeSearchInput } from "../client-validation.js";
import { LlmFetchError } from "../errors.js";
import { waitWithSignal } from "../internal/abort-signal.js";
import { PACKAGE_VERSION } from "../internal/version.js";
import { decodeBody, loadHtml } from "../retrieval/extract-content.js";
import {
  createSafeHttpFetcher,
  type SafeFetchResult,
  type SafeHttpFetcher,
  type SafeHttpFetcherOptions,
} from "../retrieval/http-fetcher.js";
import {
  createBuiltinContextGuard,
  type BuiltinContextGuardOptions,
} from "../security/context-guard.js";

export interface WikipediaOptions {
  /** Public contact URL or email address for Wikimedia's User-Agent policy. */
  contact: string;
  /** Wikipedia edition, default en. SearchInput.language overrides it. */
  language?: string;
  retrieval?: Omit<SafeHttpFetcherOptions, "userAgent" | "allowedContentTypes">;
  contextGuard?: BuiltinContextGuardOptions;
  /** Trusted transport override, responsible for honoring the User-Agent policy. */
  fetcher?: SafeHttpFetcher;
}

export interface WikipediaProvider extends SearchProvider {
  /** Opt-in section 0 retrieval; other URLs use ordinary HTTP retrieval. */
  readonly fetcher: SafeHttpFetcher;
}

function edition(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u.test(value)) {
    throw new LlmFetchError("INVALID_INPUT", "Invalid Wikipedia language edition.");
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LlmFetchError("PARSE_CHANGED", "Unexpected Wikipedia API response.");
  }
  return value as Record<string, unknown>;
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function apiUrl(language: string, parameters: Record<string, string>): URL {
  const url = new URL(`https://${edition(language)}.wikipedia.org/w/api.php`);
  url.search = new URLSearchParams({
    ...parameters,
    format: "json",
    formatversion: "2",
  }).toString();
  return url;
}

function articleUrl(language: string, title: string): string {
  return `https://${edition(language)}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /gu, "_"))}`;
}

export function wikipedia(options: WikipediaOptions): WikipediaProvider {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new LlmFetchError("INVALID_INPUT", "Wikipedia options are required.");
  }
  const contact = options.contact;
  if (
    typeof contact !== "string" ||
    !contact.trim() ||
    contact.length > 400 ||
    hasControlCharacters(contact) ||
    /[\s()]/u.test(contact) ||
    (!/^https?:\/\//u.test(contact) && !/^[^@]+@[^@]+\.[^@]+$/u.test(contact))
  ) {
    throw new LlmFetchError("CONFIG_MISSING", "Wikipedia requires a public contact URL or email.");
  }
  if (/^https?:\/\//u.test(contact)) {
    try {
      const url = new URL(contact);
      if (url.username || url.password) throw new Error("credentials");
    } catch {
      throw new LlmFetchError("INVALID_INPUT", "Invalid Wikipedia contact URL.");
    }
  }
  const language = edition(options.language ?? "en");
  if (options.fetcher !== undefined && typeof options.fetcher !== "function") {
    throw new LlmFetchError("INVALID_INPUT", "Invalid Wikipedia transport.");
  }
  const userAgent = `llm-fetch-wikipedia-bot/${PACKAGE_VERSION} (${contact})`;
  const transport =
    options.fetcher ??
    createSafeHttpFetcher({
      ...options.retrieval,
      userAgent,
      allowedContentTypes: [
        "application/json",
        "text/html",
        "application/xhtml+xml",
        "text/plain",
        "text/markdown",
        "application/xml",
        "text/xml",
      ],
    });
  const guard = createBuiltinContextGuard(options.contextGuard);
  let tail: Promise<unknown> = Promise.resolve();

  // Wikimedia recommends serial API requests. Aborted queued requests never run.
  async function request(url: URL, input: { signal?: AbortSignal } = {}) {
    const pending = tail
      .catch(() => undefined)
      .then(async () => {
        input.signal?.throwIfAborted();
        let response: SafeFetchResult;
        try {
          response = await transport(url.toString(), input);
        } catch (error) {
          if (error instanceof LlmFetchError && error.status === 429) {
            throw new LlmFetchError("RATE_LIMITED", "Wikipedia API rate limit reached.", {
              status: 429,
              retryable: true,
            });
          }
          throw error;
        }
        const finalUrl = new URL(response.finalUrl);
        if (response.status < 200 || response.status >= 300) {
          throw new LlmFetchError(
            response.status === 429 ? "RATE_LIMITED" : "UPSTREAM_HTTP",
            "Wikipedia API HTTP request failed.",
            {
              status: response.status,
              retryable: response.status === 429 || response.status >= 500,
            },
          );
        }
        if (
          finalUrl.origin !== url.origin ||
          finalUrl.pathname !== url.pathname ||
          response.contentType !== "application/json"
        ) {
          throw new LlmFetchError(
            "PARSE_CHANGED",
            "Unexpected Wikipedia API endpoint or content type.",
          );
        }
        const maxBytes = options.retrieval?.maxDecodedBytes ?? 2_000_000;
        if (response.body.byteLength > maxBytes) {
          throw new LlmFetchError(
            "RESPONSE_TOO_LARGE",
            "Wikipedia API response exceeded the byte limit.",
          );
        }
        let json: unknown;
        try {
          json = JSON.parse(decodeBody(response.body, "application/json"));
        } catch {
          throw new LlmFetchError("PARSE_CHANGED", "Invalid Wikipedia API JSON.");
        }
        return { response, json: record(json) };
      });
    tail = pending;
    return input.signal ? waitWithSignal(pending, input.signal) : pending;
  }

  function checkApiError(json: Record<string, unknown>): void {
    if (!json.error) return;
    const error = record(json.error);
    const rateLimited = error.code === "ratelimited" || error.code === "maxlag";
    throw new LlmFetchError(
      rateLimited ? "RATE_LIMITED" : "UPSTREAM_HTTP",
      "Wikipedia API returned an error.",
      { retryable: rateLimited },
    );
  }

  const fetcher: SafeHttpFetcher = async (rawUrl, input) => {
    const url = new URL(rawUrl);
    const match = /^([a-z]{2,3}(?:-[a-z0-9]{2,8})*)\.wikipedia\.org$/u.exec(url.hostname);
    if (!match || url.protocol !== "https:" || url.port || url.username || url.password)
      return transport(rawUrl, input);
    let title: string | undefined;
    if (url.pathname.startsWith("/wiki/")) {
      try {
        title = decodeURIComponent(url.pathname.slice(6)).replace(/_/gu, " ");
      } catch {
        throw new LlmFetchError("INVALID_INPUT", "Invalid Wikipedia article title.");
      }
    } else if (url.pathname === "/w/index.php") {
      title = url.searchParams.get("title") ?? undefined;
    }
    if (!title) return transport(rawUrl, input);
    const oldid = url.searchParams.get("oldid");
    if (oldid !== null && !/^[1-9]\d*$/u.test(oldid))
      throw new LlmFetchError("INVALID_INPUT", "Invalid Wikipedia revision.");
    const endpoint = apiUrl(match[1]!, {
      action: "parse",
      ...(oldid ? { oldid } : { page: title }),
      section: "0",
      prop: "text|revid",
      redirects: "1",
      disableeditsection: "1",
    });
    const { response, json } = await request(endpoint, input);
    checkApiError(json);
    const parsed = record(json.parse);
    if (
      typeof parsed.title !== "string" ||
      !parsed.title ||
      typeof parsed.text !== "string" ||
      !positiveId(parsed.revid) ||
      !positiveId(parsed.pageid)
    ) {
      throw new LlmFetchError("PARSE_CHANGED", "Unexpected Wikipedia section response.");
    }
    if (oldid !== null && String(parsed.revid) !== oldid) {
      throw new LlmFetchError("PARSE_CHANGED", "Wikipedia returned a different revision.");
    }
    const finalUrl = new URL(`https://${match[1]}.wikipedia.org/w/index.php`);
    finalUrl.search = new URLSearchParams({
      title: parsed.title,
      oldid: String(parsed.revid),
    }).toString();
    const body = new TextEncoder().encode(
      `<!doctype html><html><head><title>${escapeHtml(parsed.title)}</title></head><body><main><h1>${escapeHtml(parsed.title)}</h1>${parsed.text}</main></body></html>`,
    );
    return {
      requestedUrl: rawUrl,
      finalUrl: finalUrl.toString(),
      status: response.status,
      contentType: "text/html",
      body,
      headers: { "content-type": "text/html; charset=utf-8" },
      limitations: [
        "Only Wikipedia section 0 was retrieved; later sections were not fetched or inspected.",
      ],
      originalResponse: {
        body: response.body,
        contentType: "application/json",
        finalUrl: response.finalUrl,
      },
    };
  };

  return {
    name: "wikipedia",
    fetcher,
    async search(input) {
      const normalized = normalizeSearchInput(input);
      if (
        normalized.timeRange !== undefined ||
        (normalized.safeSearch !== undefined && normalized.safeSearch !== "off") ||
        normalized.region !== undefined
      ) {
        throw new LlmFetchError(
          "INVALID_INPUT",
          "Wikipedia does not support timeRange, region or SafeSearch filtering.",
        );
      }
      const searchLanguage = edition(
        normalized.language ?? normalized.locale?.split("-")[0] ?? language,
      );
      const endpoint = apiUrl(searchLanguage, {
        action: "query",
        list: "search",
        srsearch: normalized.query,
        srlimit: String(normalized.limit ?? 10),
        srnamespace: "0",
        srprop: "snippet|timestamp",
      });
      const { response, json } = await request(
        endpoint,
        normalized.signal ? { signal: normalized.signal } : {},
      );
      const security = await guard.inspectRaw({
        rawBody: response.body,
        contentType: "application/json",
        source: {
          kind: "search_result",
          trust: "untrusted",
          url: endpoint.toString(),
          provider: "wikipedia",
        },
        requestedUse: "answer_with_citation",
        ...(normalized.signal ? { signal: normalized.signal } : {}),
      });
      if (security.decision === "deny" || security.decision === "require_approval") {
        throw new LlmFetchError(
          "GUARD_DENIED",
          "Wikipedia API response was withheld by the context guard.",
          {
            guardDecision: security.decision,
            ...(security.reasonCodes ? { guardReasonCodes: security.reasonCodes } : {}),
            ...(security.diagnostics ? { guardDiagnostics: security.diagnostics } : {}),
          },
        );
      }
      checkApiError(json);
      const results = record(json.query).search;
      if (!Array.isArray(results))
        throw new LlmFetchError("PARSE_CHANGED", "Unexpected Wikipedia search response.");
      const hits: SearchProviderHit[] = results.map((item, index) => {
        const hit = record(item);
        if (
          typeof hit.title !== "string" ||
          !hit.title ||
          typeof hit.snippet !== "string" ||
          !positiveId(hit.pageid)
        )
          throw new LlmFetchError("PARSE_CHANGED", "Unexpected Wikipedia search result.");
        return {
          provider: "wikipedia",
          rank: index + 1,
          title: hit.title,
          url: articleUrl(searchLanguage, hit.title),
          snippet: loadHtml(hit.snippet)("body").text(),
          trust: "untrusted",
          tainted: true,
        };
      });
      return hits.slice(0, normalized.limit ?? 10);
    },
  };
}
