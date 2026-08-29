import type {
  SafeSearch,
  SearchHit,
  SearchInput,
  SearchProvider,
  TimeRange,
} from "../contracts.js";
import { LlmFetchError, toLlmFetchError } from "../errors.js";
import {
  abortReason,
  isAbortSignal,
  waitWithSignal,
} from "../internal/abort-signal.js";
import { createDeadline } from "../internal/deadline.js";
import { readResponseBytes } from "../internal/read-response.js";
import {
  extractDuckDuckGoPreloadUrl,
  parseDuckDuckGoHtml,
  parseDuckDuckGoLite,
  parseDuckDuckGoWeb,
} from "./duckduckgo-parser.js";

const WEB_ENDPOINT = "https://duckduckgo.com/";
const HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
const LITE_ENDPOINT = "https://lite.duckduckgo.com/lite/";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ALLOWED_REDIRECT_HOSTS = new Set([
  "duckduckgo.com",
  "html.duckduckgo.com",
  "links.duckduckgo.com",
  "lite.duckduckgo.com",
]);
const HTML_CONTENT_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
]);
const SCRIPT_CONTENT_TYPES = new Set([
  "application/javascript",
  "application/x-javascript",
  "text/javascript",
]);

interface DuckDuckGoRequest {
  endpoint: string | URL;
  method: "GET" | "POST";
  body?: URLSearchParams;
  accept: string;
  contentTypes: ReadonlySet<string>;
}

export interface DuckDuckGoOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  userAgent?: string;
  fetch?: typeof globalThis.fetch;
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      `${name} must be an integer between 1 and ${maximum}.`,
      { provider: "duckduckgo" },
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

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function validateUserAgent(value: string | undefined): string {
  const rawUserAgent: unknown = value ?? DEFAULT_USER_AGENT;
  if (typeof rawUserAgent !== "string") {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "userAgent must contain between 1 and 512 header-safe characters.",
      { provider: "duckduckgo" },
    );
  }
  const userAgent = rawUserAgent.trim();
  if (
    !userAgent ||
    userAgent.length > 512 ||
    containsControlCharacter(userAgent)
  ) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "userAgent must contain between 1 and 512 header-safe characters.",
      { provider: "duckduckgo" },
    );
  }
  return userAgent;
}

function withDuckDuckGoContext(error: LlmFetchError): LlmFetchError {
  if (error.provider === "duckduckgo") return error;
  return new LlmFetchError(error.code, error.message, {
    cause: error,
    provider: "duckduckgo",
    retryable:
      error.code === "UPSTREAM_HTTP" ? true : error.retryable,
    ...(error.url === undefined ? {} : { url: error.url }),
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.cooldownMs === undefined
      ? {}
      : { cooldownMs: error.cooldownMs }),
  });
}

function preferObservedChallenge(
  finalError: unknown,
  observedChallenge: LlmFetchError | undefined,
): unknown {
  if (!observedChallenge || !(finalError instanceof LlmFetchError)) {
    return finalError;
  }
  if (
    finalError.retryable &&
    (finalError.code === "BOT_CHALLENGE" ||
      finalError.code === "PARSE_CHANGED" ||
      finalError.code === "UPSTREAM_HTTP")
  ) {
    return observedChallenge;
  }
  return finalError;
}

function safeSearchValue(value: SafeSearch | undefined): string {
  switch (value ?? "moderate") {
    case "strict":
      return "1";
    case "moderate":
      return "-1";
    case "off":
      return "-2";
  }
}

function timeRangeValue(value: TimeRange | undefined): string | undefined {
  switch (value) {
    case "day":
      return "d";
    case "week":
      return "w";
    case "month":
      return "m";
    case "year":
      return "y";
    case undefined:
      return undefined;
  }
}

const DEFAULT_REGION_BY_LANGUAGE: Readonly<Record<string, string>> = {
  bg: "BG",
  cs: "CZ",
  da: "DK",
  de: "DE",
  el: "GR",
  en: "US",
  es: "ES",
  et: "EE",
  fi: "FI",
  fr: "FR",
  he: "IL",
  hr: "HR",
  hu: "HU",
  id: "ID",
  it: "IT",
  ja: "JP",
  ko: "KR",
  lt: "LT",
  lv: "LV",
  ms: "MY",
  nl: "NL",
  no: "NO",
  pl: "PL",
  pt: "PT",
  ro: "RO",
  ru: "RU",
  sk: "SK",
  sl: "SI",
  sv: "SE",
  th: "TH",
  tl: "PH",
  tr: "TR",
  uk: "UA",
  vi: "VN",
  zh: "CN",
};
const DUCKDUCKGO_REGION_CODES = new Map([
  ["AR:es", "ar-es"], ["AU:en", "au-en"], ["AT:de", "at-de"],
  ["BE:fr", "be-fr"], ["BE:nl", "be-nl"], ["BR:pt", "br-pt"],
  ["BG:bg", "bg-bg"], ["CA:en", "ca-en"], ["CA:fr", "ca-fr"],
  ["CL:es", "cl-es"], ["CN:zh", "cn-zh"], ["CO:es", "co-es"],
  ["HR:hr", "hr-hr"], ["CZ:cs", "cz-cs"], ["DK:da", "dk-da"],
  ["EE:et", "ee-et"], ["FI:fi", "fi-fi"], ["FR:fr", "fr-fr"],
  ["DE:de", "de-de"], ["GR:el", "gr-el"], ["HK:zh", "hk-tzh"],
  ["HU:hu", "hu-hu"], ["IN:en", "in-en"], ["ID:id", "id-id"],
  ["ID:en", "id-en"], ["IE:en", "ie-en"], ["IL:he", "il-he"],
  ["IT:it", "it-it"], ["JP:ja", "jp-jp"], ["KR:ko", "kr-kr"],
  ["LV:lv", "lv-lv"], ["LT:lt", "lt-lt"], ["MY:ms", "my-ms"],
  ["MY:en", "my-en"], ["MX:es", "mx-es"], ["NL:nl", "nl-nl"],
  ["NZ:en", "nz-en"], ["NO:no", "no-no"], ["PE:es", "pe-es"],
  ["PH:en", "ph-en"], ["PH:tl", "ph-tl"], ["PL:pl", "pl-pl"],
  ["PT:pt", "pt-pt"], ["RO:ro", "ro-ro"], ["RU:ru", "ru-ru"],
  ["SG:en", "sg-en"], ["SK:sk", "sk-sk"], ["SI:sl", "sl-sl"],
  ["ZA:en", "za-en"], ["ES:es", "es-es"], ["SE:sv", "se-sv"],
  ["CH:de", "ch-de"], ["CH:fr", "ch-fr"], ["CH:it", "ch-it"],
  ["TW:zh", "tw-tzh"], ["TH:th", "th-th"], ["TR:tr", "tr-tr"],
  ["UA:uk", "ua-uk"], ["GB:en", "uk-en"], ["US:en", "us-en"],
  ["US:es", "ue-es"], ["VE:es", "ve-es"], ["VN:vi", "vn-vi"],
]);

function duckDuckGoRegion(input: SearchInput): string | undefined {
  if (input.locale) return input.locale.trim();
  const language = input.language?.toLowerCase();
  const region =
    input.region?.toUpperCase() ??
    (language ? DEFAULT_REGION_BY_LANGUAGE[language] : undefined);
  if (!region) {
    if (!language) return undefined;
    throw new LlmFetchError(
      "INVALID_INPUT",
      "DuckDuckGo does not support the requested language without an explicit region.",
      { provider: "duckduckgo" },
    );
  }
  const code = language
    ? DUCKDUCKGO_REGION_CODES.get(`${region}:${language}`)
    : [...DUCKDUCKGO_REGION_CODES].find(([key]) =>
        key.startsWith(`${region}:`),
      )?.[1];
  if (!code) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "DuckDuckGo does not support the requested language and region combination.",
      { provider: "duckduckgo" },
    );
  }
  return code;
}

function validateSearchInput(
  input: SearchInput,
): Required<Pick<SearchInput, "query" | "limit">> {
  if (!input || typeof input !== "object" || typeof input.query !== "string") {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "Search input and query are required.",
      {
        provider: "duckduckgo",
      },
    );
  }
  const query = input.query.trim();
  const limit = input.limit ?? 10;
  if (!query || query.length > 400) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "Search query must contain between 1 and 400 characters.",
      { provider: "duckduckgo" },
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "Search limit must be an integer between 1 and 20.",
      { provider: "duckduckgo" },
    );
  }
  if (
    input.safeSearch !== undefined &&
    !(["strict", "moderate", "off"] as const).includes(input.safeSearch)
  ) {
    throw new LlmFetchError("INVALID_INPUT", "safeSearch is invalid.", {
      provider: "duckduckgo",
    });
  }
  if (
    input.timeRange !== undefined &&
    !(["day", "week", "month", "year"] as const).includes(input.timeRange)
  ) {
    throw new LlmFetchError("INVALID_INPUT", "timeRange is invalid.", {
      provider: "duckduckgo",
    });
  }
  if (
    input.locale !== undefined &&
    (typeof input.locale !== "string" ||
      !input.locale.trim() ||
      input.locale.length > 100)
  ) {
    throw new LlmFetchError("INVALID_INPUT", "locale is invalid.", {
      provider: "duckduckgo",
    });
  }
  if (
    input.language !== undefined &&
    (typeof input.language !== "string" ||
      !/^[a-z]{2}$/iu.test(input.language))
  ) {
    throw new LlmFetchError("INVALID_INPUT", "language is invalid.", {
      provider: "duckduckgo",
    });
  }
  if (
    input.region !== undefined &&
    (typeof input.region !== "string" || !/^[a-z]{2}$/iu.test(input.region))
  ) {
    throw new LlmFetchError("INVALID_INPUT", "region is invalid.", {
      provider: "duckduckgo",
    });
  }
  if (input.locale && (input.language || input.region)) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "locale cannot be combined with language or region.",
      { provider: "duckduckgo" },
    );
  }
  if (input.signal !== undefined && !isAbortSignal(input.signal)) {
    throw new LlmFetchError("INVALID_INPUT", "signal must be an AbortSignal.", {
      provider: "duckduckgo",
    });
  }
  input.signal?.throwIfAborted();
  return { query, limit };
}

export function duckDuckGo(options: DuckDuckGoOptions = {}): SearchProvider {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "DuckDuckGo options must be an object.",
      {
        provider: "duckduckgo",
      },
    );
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new LlmFetchError(
      "CONFIG_MISSING",
      "A Fetch implementation is required.",
      {
        provider: "duckduckgo",
      },
    );
  }
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? 4_000,
    "timeoutMs",
    300_000,
  );
  const maxResponseBytes = positiveInteger(
    options.maxResponseBytes ?? 750_000,
    "maxResponseBytes",
    10_000_000,
  );
  const userAgent = validateUserAgent(options.userAgent);
  let cooldown:
    | {
        until: number;
        code: "RATE_LIMITED" | "BOT_CHALLENGE";
        status?: number;
      }
    | undefined;

  function throwIfCoolingDown(): void {
    if (!cooldown) return;
    const remaining = Math.ceil(cooldown.until - Date.now());
    if (remaining <= 0) {
      cooldown = undefined;
      return;
    }
    throw new LlmFetchError(
      cooldown.code,
      "DuckDuckGo search is temporarily paused after an upstream limit or challenge.",
      {
        provider: "duckduckgo",
        retryable: true,
        cooldownMs: remaining,
        ...(cooldown.status === undefined ? {} : { status: cooldown.status }),
      },
    );
  }

  function rememberCooldown(error: unknown): void {
    if (
      !(error instanceof LlmFetchError) ||
      (error.code !== "RATE_LIMITED" && error.code !== "BOT_CHALLENGE") ||
      !error.cooldownMs ||
      error.cooldownMs <= 0
    ) {
      return;
    }
    cooldown = {
      until: Date.now() + error.cooldownMs,
      code: error.code,
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  }

  async function request(
    requestOptions: DuckDuckGoRequest,
    input: SearchInput,
    deadline: ReturnType<typeof createDeadline>,
  ): Promise<string> {
    let current = new URL(requestOptions.endpoint);
    let method = requestOptions.method;
    for (let redirects = 0; redirects <= 2; redirects += 1) {
      if (deadline.remainingMs() <= 0) {
        throw new LlmFetchError("TIMEOUT", "DuckDuckGo search timed out.", {
          provider: "duckduckgo",
          retryable: true,
        });
      }
      let response: Response;
      try {
        const requestInit: RequestInit = {
          method,
          redirect: "manual",
          signal: deadline.signal(input.signal),
          headers: {
            accept: requestOptions.accept,
            "accept-language": "en-US,en;q=0.9",
            "user-agent": userAgent,
          },
        };
        if (method === "POST" && requestOptions.body) {
          requestInit.body = requestOptions.body;
          requestInit.headers = {
            ...requestInit.headers,
            "content-type": "application/x-www-form-urlencoded",
            origin: "https://duckduckgo.com",
            referer: "https://duckduckgo.com/",
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "same-site",
            "sec-fetch-user": "?1",
          };
        }
        response = await waitWithSignal(
          fetchImpl(current, requestInit),
          requestInit.signal as AbortSignal,
        );
      } catch (error) {
        if (input.signal?.aborted) throw abortReason(input.signal);
        if (
          deadline.remainingMs() <= 0 ||
          (error instanceof Error && error.name === "TimeoutError")
        ) {
          throw new LlmFetchError("TIMEOUT", "DuckDuckGo search timed out.", {
            provider: "duckduckgo",
            retryable: true,
            cause: error,
          });
        }
        throw toLlmFetchError(error, {
          code: "UPSTREAM_HTTP",
          message: "DuckDuckGo search request failed.",
          provider: "duckduckgo",
          retryable: true,
        });
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        discardBody(response);
        if (!location || redirects === 2) {
          throw new LlmFetchError(
            "UPSTREAM_HTTP",
            "DuckDuckGo returned too many redirects.",
            {
              provider: "duckduckgo",
              status: response.status,
              retryable: true,
            },
          );
        }
        try {
          current = new URL(location, current);
        } catch (error) {
          throw new LlmFetchError(
            "UPSTREAM_HTTP",
            "DuckDuckGo returned an invalid redirect.",
            {
              provider: "duckduckgo",
              status: response.status,
              cause: error,
            },
          );
        }
        if (
          current.protocol !== "https:" ||
          current.port !== "" ||
          current.username !== "" ||
          current.password !== "" ||
          !ALLOWED_REDIRECT_HOSTS.has(current.hostname.toLowerCase())
        ) {
          throw new LlmFetchError(
            "UNSAFE_URL",
            "DuckDuckGo redirected to an unexpected host.",
            { provider: "duckduckgo" },
          );
        }
        if ([301, 302, 303].includes(response.status)) method = "GET";
        continue;
      }

      if (response.status === 429) {
        discardBody(response);
        throw new LlmFetchError(
          "RATE_LIMITED",
          "DuckDuckGo rate limited the request.",
          {
            provider: "duckduckgo",
            status: 429,
            retryable: true,
            cooldownMs: 60_000,
          },
        );
      }
      if (response.status === 202) {
        discardBody(response);
        throw new LlmFetchError(
          "BOT_CHALLENGE",
          "DuckDuckGo returned a bot challenge.",
          {
            provider: "duckduckgo",
            status: response.status,
            retryable: true,
            cooldownMs: 60_000,
          },
        );
      }
      if (response.status >= 500) {
        discardBody(response);
        throw new LlmFetchError(
          "UPSTREAM_HTTP",
          `DuckDuckGo returned HTTP ${response.status}.`,
          { provider: "duckduckgo", status: response.status, retryable: true },
        );
      }
      if (!response.ok) {
        discardBody(response);
        throw new LlmFetchError(
          "UPSTREAM_HTTP",
          `DuckDuckGo returned HTTP ${response.status}.`,
          { provider: "duckduckgo", status: response.status },
        );
      }

      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (contentType && !requestOptions.contentTypes.has(contentType)) {
        discardBody(response);
        throw new LlmFetchError(
          "PARSE_CHANGED",
          "DuckDuckGo returned an unexpected response type.",
          {
            provider: "duckduckgo",
            retryable: true,
          },
        );
      }
      let bytes: Uint8Array;
      try {
        bytes = await readResponseBytes(
          response,
          maxResponseBytes,
          deadline.signal(input.signal),
        );
      } catch (error) {
        if (error instanceof LlmFetchError) {
          throw withDuckDuckGoContext(error);
        }
        if (input.signal?.aborted) throw abortReason(input.signal);
        if (
          deadline.remainingMs() <= 0 ||
          (error instanceof Error && error.name === "TimeoutError")
        ) {
          throw new LlmFetchError("TIMEOUT", "DuckDuckGo search timed out.", {
            provider: "duckduckgo",
            retryable: true,
            cause: error,
          });
        }
        throw toLlmFetchError(error, {
          code: "UPSTREAM_HTTP",
          message: "DuckDuckGo search response failed.",
          provider: "duckduckgo",
          retryable: true,
        });
      }
      return new TextDecoder().decode(bytes);
    }
    throw new LlmFetchError(
      "UPSTREAM_HTTP",
      "DuckDuckGo request did not complete.",
      {
        provider: "duckduckgo",
        retryable: true,
      },
    );
  }

  function searchForm(input: SearchInput, query: string): URLSearchParams {
    const body = new URLSearchParams({
      q: query,
      kp: safeSearchValue(input.safeSearch),
    });
    const region = duckDuckGoRegion(input);
    if (region) body.set("kl", region);
    const range = timeRangeValue(input.timeRange);
    if (range) body.set("df", range);
    return body;
  }

  function canTryAlternate(error: unknown): boolean {
    return (
      error instanceof LlmFetchError &&
      (error.code === "PARSE_CHANGED" ||
        error.code === "BOT_CHALLENGE" ||
        (error.code === "UPSTREAM_HTTP" &&
          error.retryable &&
          (error.status === undefined || error.status >= 500)))
    );
  }

  async function searchWeb(
    input: SearchInput,
    query: string,
    limit: number,
    deadline: ReturnType<typeof createDeadline>,
  ): Promise<SearchHit[]> {
    const bootstrapUrl = new URL(WEB_ENDPOINT);
    bootstrapUrl.searchParams.set("q", query);
    bootstrapUrl.searchParams.set("ia", "web");
    bootstrapUrl.searchParams.set("kp", safeSearchValue(input.safeSearch));
    const region = duckDuckGoRegion(input);
    if (region) bootstrapUrl.searchParams.set("kl", region);
    const range = timeRangeValue(input.timeRange);
    if (range) bootstrapUrl.searchParams.set("df", range);

    const bootstrap = await request(
      {
        endpoint: bootstrapUrl,
        method: "GET",
        accept: "text/html,application/xhtml+xml",
        contentTypes: HTML_CONTENT_TYPES,
      },
      input,
      deadline,
    );
    const preloadUrl = extractDuckDuckGoPreloadUrl(bootstrap, query);
    const script = await request(
      {
        endpoint: preloadUrl,
        method: "GET",
        accept: "application/javascript,text/javascript;q=0.9,*/*;q=0.1",
        contentTypes: SCRIPT_CONTENT_TYPES,
      },
      input,
      deadline,
    );
    return parseDuckDuckGoWeb(script, limit);
  }

  async function searchNonJavaScript(
    input: SearchInput,
    query: string,
    limit: number,
    deadline: ReturnType<typeof createDeadline>,
    observeFailure: (error: unknown) => void,
  ): Promise<SearchHit[]> {
    const form = searchForm(input, query);
    try {
      const html = await request(
        {
          endpoint: HTML_ENDPOINT,
          method: "POST",
          body: form,
          accept: "text/html,application/xhtml+xml",
          contentTypes: HTML_CONTENT_TYPES,
        },
        input,
        deadline,
      );
      return parseDuckDuckGoHtml(html, limit);
    } catch (error) {
      observeFailure(error);
      if (!canTryAlternate(error)) throw error;
    }

    try {
      const liteHtml = await request(
        {
          endpoint: LITE_ENDPOINT,
          method: "POST",
          body: form,
          accept: "text/html,application/xhtml+xml",
          contentTypes: HTML_CONTENT_TYPES,
        },
        input,
        deadline,
      );
      return parseDuckDuckGoLite(liteHtml, limit);
    } catch (error) {
      observeFailure(error);
      throw error;
    }
  }

  return {
    name: "duckduckgo",
    async search(input: SearchInput): Promise<SearchHit[]> {
      const { query, limit } = validateSearchInput(input);
      throwIfCoolingDown();
      const deadline = createDeadline(timeoutMs);
      let observedChallenge: LlmFetchError | undefined;
      const observeFailure = (error: unknown): void => {
        if (
          error instanceof LlmFetchError &&
          error.code === "BOT_CHALLENGE"
        ) {
          observedChallenge = error;
        }
      };

      try {
        try {
          return await searchWeb(input, query, limit, deadline);
        } catch (error) {
          observeFailure(error);
          if (!canTryAlternate(error)) throw error;
        }
        return await searchNonJavaScript(
          input,
          query,
          limit,
          deadline,
          observeFailure,
        );
      } catch (error) {
        const finalError = preferObservedChallenge(error, observedChallenge);
        rememberCooldown(finalError);
        if (
          finalError !== observedChallenge &&
          (!(finalError instanceof LlmFetchError) ||
            finalError.code !== "RATE_LIMITED")
        ) {
          rememberCooldown(observedChallenge);
        }
        throw finalError;
      }
    },
  };
}
