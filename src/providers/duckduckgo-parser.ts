import type { SearchHit } from "../contracts.js";
import { LlmFetchError } from "../errors.js";
import { loadHtml } from "../retrieval/extract-content.js";
import { normalizeResultUrl } from "../retrieval/url-normalizer.js";

const MAX_RESULT_CANDIDATES = 1_000;

const NO_RESULTS_SELECTORS = [
  ".no-results",
  ".results--empty",
  "#no-results",
];

const CHALLENGE_PATTERNS = [
  /DDG\.(?:deep\.)?anomalyDetectionBlock\s*\(/i,
  /(?:id|class)=["'][^"']*\banomaly-modal\b/i,
  /(?:id|class)=["'][^"']*\bbot_challenge\b/i,
  /(?:id|class)=["'][^"']*\bchallenge-form\b/i,
  /Unfortunately,\s+bots\s+use\s+DuckDuckGo\s+too/i,
  /Please\s+complete\s+the\s+following\s+challenge/i,
];

const VQD_PATTERN = /\bvqd\s*=\s*["'](\d+-\d+(?:-\d+)?)["']/;
const WEB_RESULTS_MARKER = /DDG\.pageLayout\.load\(\s*["']d["']\s*,/;

function textOf(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function loadProviderHtml(html: string) {
  try {
    return loadHtml(html);
  } catch (error) {
    if (error instanceof LlmFetchError && error.provider === undefined) {
      throw new LlmFetchError(error.code, error.message, {
        cause: error,
        provider: "duckduckgo",
        retryable: error.retryable,
      });
    }
    throw error;
  }
}

function assertNotChallenge(body: string): void {
  if (CHALLENGE_PATTERNS.some((pattern) => pattern.test(body))) {
    throw new LlmFetchError(
      "BOT_CHALLENGE",
      "DuckDuckGo returned a bot challenge.",
      { provider: "duckduckgo", retryable: true, cooldownMs: 60_000 },
    );
  }
}

function decodeHtmlText(value: string): string {
  return textOf(loadProviderHtml(`<body>${value}</body>`)("body").text());
}

function tooManyResults(): LlmFetchError {
  return new LlmFetchError(
    "RESPONSE_TOO_LARGE",
    "DuckDuckGo returned too many result candidates.",
    { provider: "duckduckgo" },
  );
}

function parseWebPayload(body: string): unknown[] {
  const marker = WEB_RESULTS_MARKER.exec(body);
  if (!marker) {
    throw new LlmFetchError(
      "PARSE_CHANGED",
      "DuckDuckGo Web did not contain a recognized result payload.",
      { provider: "duckduckgo", retryable: true },
    );
  }

  const start = body.indexOf("[", marker.index + marker[0].length);
  if (start < 0) {
    throw new LlmFetchError(
      "PARSE_CHANGED",
      "DuckDuckGo Web returned a malformed result payload.",
      { provider: "duckduckgo", retryable: true },
    );
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < body.length; index += 1) {
    const character = body[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(body.slice(start, index + 1));
          if (Array.isArray(parsed)) return parsed;
        } catch {
          // Report the bounded provider parse error below.
        }
        throw new LlmFetchError(
          "PARSE_CHANGED",
          "DuckDuckGo Web returned invalid result JSON.",
          { provider: "duckduckgo", retryable: true },
        );
      }
    }
  }

  throw new LlmFetchError(
    "PARSE_CHANGED",
    "DuckDuckGo Web returned an incomplete result payload.",
    { provider: "duckduckgo", retryable: true },
  );
}

function toHit(
  rank: number,
  title: string,
  rawUrl: string,
  snippet: string,
  displayUrl?: string,
): SearchHit | null {
  const url = normalizeResultUrl(rawUrl);
  const normalizedTitle = textOf(title).slice(0, 1_000);
  if (!url || !normalizedTitle) return null;
  const hit: SearchHit = {
    trust: "untrusted",
    tainted: true,
    provider: "duckduckgo",
    rank,
    title: normalizedTitle,
    url,
    snippet: textOf(snippet).slice(0, 10_000),
  };
  const normalizedDisplayUrl = displayUrl ? textOf(displayUrl).slice(0, 2_048) : "";
  if (normalizedDisplayUrl) hit.displayUrl = normalizedDisplayUrl;
  return hit;
}

export function parseDuckDuckGoHtml(html: string, limit: number): SearchHit[] {
  assertNotChallenge(html);
  const $ = loadProviderHtml(html);
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const candidates = $(".result");
  if (candidates.length > MAX_RESULT_CANDIDATES) throw tooManyResults();

  for (const element of candidates.toArray()) {
    const anchor = $(element).find("a.result__a").first();
    const hit = toHit(
      hits.length + 1,
      anchor.text(),
      anchor.attr("href") ?? "",
      $(element).find(".result__snippet").first().text(),
      $(element).find(".result__url").first().text(),
    );
    if (!hit || seen.has(hit.url)) continue;
    seen.add(hit.url);
    hits.push({ ...hit, rank: hits.length + 1 });
    if (hits.length >= limit) break;
  }
  if (hits.length > 0) return hits;

  const hasNoResults = NO_RESULTS_SELECTORS.some(
    (selector) => $(selector).length > 0,
  );
  if (hasNoResults || /no results\.?/i.test($("body").text())) return [];

  throw new LlmFetchError(
    "PARSE_CHANGED",
    "DuckDuckGo HTML did not contain a recognized result structure.",
    { provider: "duckduckgo", retryable: true },
  );
}

export function parseDuckDuckGoLite(html: string, limit: number): SearchHit[] {
  assertNotChallenge(html);
  const $ = loadProviderHtml(html);
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const candidates = $("a.result-link, a.result__a");
  if (candidates.length > MAX_RESULT_CANDIDATES) throw tooManyResults();
  const snippets = $(".result-snippet").slice(0, MAX_RESULT_CANDIDATES).toArray();

  for (const [index, element] of candidates.toArray().entries()) {
    const anchor = $(element);
    const row = anchor.closest("tr");
    const snippet = snippets[index];
    const snippetText = snippet
      ? $(snippet).text()
      : row.nextAll("tr").slice(0, 2).text();
    const hit = toHit(
      hits.length + 1,
      anchor.text(),
      anchor.attr("href") ?? "",
      snippetText,
    );
    if (!hit || seen.has(hit.url)) continue;
    seen.add(hit.url);
    hits.push({ ...hit, rank: hits.length + 1 });
    if (hits.length >= limit) break;
  }
  if (hits.length > 0) return hits;
  if (/no results\.?/i.test($("body").text())) return [];

  throw new LlmFetchError(
    "PARSE_CHANGED",
    "DuckDuckGo Lite did not contain a recognized result structure.",
    { provider: "duckduckgo", retryable: true },
  );
}

export function extractDuckDuckGoPreloadUrl(
  html: string,
  expectedQuery: string,
): URL {
  assertNotChallenge(html);
  const vqd = VQD_PATTERN.exec(html)?.[1];
  if (!vqd) {
    throw new LlmFetchError(
      "PARSE_CHANGED",
      "DuckDuckGo bootstrap did not contain a VQD token.",
      { provider: "duckduckgo", retryable: true },
    );
  }

  const $ = loadProviderHtml(html);
  const source = $("script[src]")
    .toArray()
    .map((element) => $(element).attr("src"))
    .find((value) => value?.includes("/d.js") === true);
  if (!source || source.length > 16_384) {
    throw new LlmFetchError(
      "PARSE_CHANGED",
      "DuckDuckGo bootstrap did not contain a Web preload URL.",
      { provider: "duckduckgo", retryable: true },
    );
  }

  let url: URL;
  try {
    url = new URL(source, "https://duckduckgo.com/");
  } catch (error) {
    throw new LlmFetchError(
      "PARSE_CHANGED",
      "DuckDuckGo bootstrap contained an invalid Web preload URL.",
      { provider: "duckduckgo", cause: error },
    );
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "links.duckduckgo.com" ||
    url.port !== "" ||
    url.pathname !== "/d.js" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.searchParams.getAll("vqd").length !== 1 ||
    url.searchParams.get("vqd") !== vqd ||
    url.searchParams.getAll("q").length !== 1 ||
    url.searchParams.get("q") !== expectedQuery
  ) {
    throw new LlmFetchError(
      "PARSE_CHANGED",
      "DuckDuckGo bootstrap contained an untrusted Web preload URL.",
      { provider: "duckduckgo" },
    );
  }
  return url;
}

export function parseDuckDuckGoWeb(
  body: string,
  limit: number,
): SearchHit[] {
  assertNotChallenge(body);
  const payload = parseWebPayload(body);
  if (payload.length > MAX_RESULT_CANDIDATES) throw tooManyResults();
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  let invalidResult = false;

  for (const candidate of payload) {
    if (!candidate || typeof candidate !== "object") {
      invalidResult = true;
      continue;
    }
    if ("n" in candidate) continue;
    const raw = candidate as Record<string, unknown>;
    if (
      typeof raw.t !== "string" ||
      typeof raw.a !== "string" ||
      typeof raw.u !== "string"
    ) {
      invalidResult = true;
      continue;
    }
    const normalizedUrl = normalizeResultUrl(raw.u);
    if (!normalizedUrl) {
      invalidResult = true;
      continue;
    }
    if (seen.has(normalizedUrl)) continue;
    const hit = toHit(
      hits.length + 1,
      decodeHtmlText(raw.t),
      raw.u,
      decodeHtmlText(raw.a),
      typeof raw.i === "string" ? raw.i : undefined,
    );
    if (!hit) {
      invalidResult = true;
      continue;
    }
    seen.add(hit.url);
    hits.push({ ...hit, rank: hits.length + 1 });
    if (hits.length >= limit) break;
  }

  if (hits.length > 0) return hits;
  if (!invalidResult) return [];

  throw new LlmFetchError(
    "PARSE_CHANGED",
    "DuckDuckGo Web result entries did not match the expected structure.",
    { provider: "duckduckgo", retryable: true },
  );
}
