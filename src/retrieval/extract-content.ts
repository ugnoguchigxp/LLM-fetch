import { load, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { LlmFetchError } from "../errors.js";
import {
  assertHtmlSourceWithinLimits,
  assertParsedHtmlWithinLimits,
  DEFAULT_HTML_STRUCTURE_LIMITS,
  domNodeChildren,
  domNodeData,
  domNodeName,
  type HtmlStructureLimits,
} from "./html-limits.js";
import { scoreContentCandidate } from "./quality.js";

const CANDIDATE_SELECTORS = [
  "article",
  "main",
  "[role='main']",
  "#content",
  ".content",
  ".main",
  "body",
] as const;

const BLOCK_ELEMENTS = new Set([
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "li",
  "p",
  "pre",
  "td",
]);

function normalizeInlineText(value: string): string {
  return value.replace(/[\t\f\v ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

function normalizePlainText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const CHARSET_ALIASES = new Map([
  ["utf8", "utf-8"],
  ["utf-8", "utf-8"],
  ["utf16", "utf-16le"],
  ["utf-16", "utf-16le"],
  ["utf-16le", "utf-16le"],
  ["utf-16be", "utf-16be"],
  ["shift-jis", "shift_jis"],
  ["shift_jis", "shift_jis"],
  ["sjis", "shift_jis"],
  ["windows-31j", "shift_jis"],
  ["cp932", "shift_jis"],
]);

function declaredCharset(value: string): string | undefined {
  return /(?:^|[;\s])charset\s*=\s*["']?([^;"'\s/>]+)/iu.exec(
    value,
  )?.[1]?.toLowerCase();
}

function bomCharset(body: Uint8Array): { charset: string; offset: number } | undefined {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    return { charset: "utf-8", offset: 3 };
  }
  if (body[0] === 0xff && body[1] === 0xfe) {
    return { charset: "utf-16le", offset: 2 };
  }
  if (body[0] === 0xfe && body[1] === 0xff) {
    return { charset: "utf-16be", offset: 2 };
  }
  return undefined;
}

function metaCharset(body: Uint8Array): string | undefined {
  const preview = new TextDecoder("windows-1252").decode(body.slice(0, 4_096));
  const direct = /<meta\b[^>]*\scharset\s*=\s*["']?\s*([^\s"'/>;]+)/iu.exec(
    preview,
  )?.[1];
  if (direct) return direct.toLowerCase();
  const httpEquiv = /<meta\b(?=[^>]*\shttp-equiv\s*=\s*["']?content-type["']?)[^>]*\scontent\s*=\s*["']([^"']+)["'][^>]*>/iu.exec(
    preview,
  )?.[1];
  return httpEquiv ? declaredCharset(httpEquiv) : undefined;
}

function normalizeCharset(charset: string): string {
  const normalized = CHARSET_ALIASES.get(charset.toLowerCase());
  if (!normalized) {
    throw new LlmFetchError(
      "UNSUPPORTED_CONTENT_ENCODING",
      `Unsupported character encoding: ${charset.toLowerCase()}.`,
    );
  }
  return normalized;
}

export function decodeBody(body: Uint8Array, contentTypeHeader: string): string {
  const bom = bomCharset(body);
  const mediaType = contentTypeHeader.split(";", 1)[0]?.trim().toLowerCase();
  const declared = declaredCharset(contentTypeHeader);
  const fromMeta =
    !declared &&
    (mediaType === "text/html" || mediaType === "application/xhtml+xml")
      ? metaCharset(body)
      : undefined;
  const charset = normalizeCharset(bom?.charset ?? declared ?? fromMeta ?? "utf-8");
  try {
    return new TextDecoder(charset, { fatal: true }).decode(
      bom ? body.subarray(bom.offset) : body,
    );
  } catch (error) {
    if (error instanceof LlmFetchError) throw error;
    throw new LlmFetchError(
      "UNSUPPORTED_CONTENT_ENCODING",
      `The response is not valid ${charset} text.`,
      { cause: error },
    );
  }
}

export interface ExtractedContent {
  title: string;
  text: string;
  characterCount: number;
  truncated: boolean;
  excerpt?: string;
}

export interface ExtractContentOptions {
  maxCharacters?: number;
  minCharacters?: number;
}

function candidateMetrics(element: AnyNode): {
  text: string;
  paragraphCount: number;
  linkTextLength: number;
} {
  type Entry = {
    node: unknown;
    insideLink: boolean;
    blockTextVersion?: number;
  };
  const stack: Entry[] = [{ node: element, insideLink: false }];
  const textParts: string[] = [];
  const linkTextParts: string[] = [];
  let textVersion = 0;
  let paragraphCount = 0;

  const separator = (): void => {
    if (textParts.length > 0) textParts.push("\n\n");
  };

  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    if (entry.blockTextVersion !== undefined) {
      if (textVersion > entry.blockTextVersion) paragraphCount += 1;
      separator();
      continue;
    }

    const name = domNodeName(entry.node);
    const block = BLOCK_ELEMENTS.has(name);
    if (block) separator();
    const data = domNodeData(entry.node);
    if (data) {
      textParts.push(data);
      if (/\S/u.test(data)) textVersion += 1;
      if (entry.insideLink) linkTextParts.push(data);
    }

    const children = domNodeChildren(entry.node);
    if (block) {
      stack.push({
        node: entry.node,
        insideLink: entry.insideLink,
        blockTextVersion: textVersion,
      });
    }
    const insideLink = entry.insideLink || name === "a";
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index], insideLink });
    }
  }

  return {
    text: normalizePlainText(textParts.join("")),
    paragraphCount,
    linkTextLength: normalizeInlineText(linkTextParts.join(" ")).length,
  };
}

export function loadHtml(
  html: string,
  limits: HtmlStructureLimits = {},
): CheerioAPI {
  assertHtmlSourceWithinLimits(html, limits);
  try {
    const $ = load(html);
    assertParsedHtmlWithinLimits($, limits);
    return $;
  } catch (error) {
    if (error instanceof LlmFetchError) throw error;
    throw new LlmFetchError(
      "CONTENT_INSUFFICIENT",
      "The HTML response could not be parsed safely.",
      { cause: error },
    );
  }
}

export function loadXml(
  xml: string,
  limits: HtmlStructureLimits = {},
): CheerioAPI {
  assertHtmlSourceWithinLimits(xml, limits, true);
  try {
    const $ = load(xml, { xmlMode: true });
    assertParsedHtmlWithinLimits($, limits);
    return $;
  } catch (error) {
    if (error instanceof LlmFetchError) throw error;
    throw new LlmFetchError(
      "CONTENT_INSUFFICIENT",
      "The XML response could not be parsed safely.",
      { cause: error },
    );
  }
}

export function extractHtmlContent(
  $: CheerioAPI,
  finalUrl: string,
  options: ExtractContentOptions = {},
): ExtractedContent {
  const maxCharacters = options.maxCharacters ?? 20_000;
  const minCharacters = options.minCharacters ?? 80;
  const title = normalizeInlineText(
    $("meta[property='og:title']").attr("content") ||
      $("title").first().text() ||
      $("h1").first().text(),
  ).replace(/\s+/gu, " ").slice(0, 1_000);

  $("script, style, nav, header, footer, aside, noscript, svg, iframe, object, embed, form, input, textarea, select, option, button, .advertisement, .ads, .sidebar").remove();

  let bestText = "";
  let bestScore = Number.NEGATIVE_INFINITY;
  const candidateElements: AnyNode[] = [];
  const candidateSet = new Set<AnyNode>();
  const selected = new Set<unknown>();
  const ancestorsOfSelected = new Set<unknown>();

  for (const selector of CANDIDATE_SELECTORS) {
    $(selector).each((_index, element) => {
      if (candidateSet.has(element)) return;
      candidateSet.add(element);
      candidateElements.push(element);
      if (
        candidateElements.length >
        DEFAULT_HTML_STRUCTURE_LIMITS.maxCandidates
      ) {
        throw new LlmFetchError(
          "RESPONSE_TOO_LARGE",
          "The HTML response exceeded the content-candidate limit.",
          { url: finalUrl },
        );
      }
    });
  }

  const hasSelectedAncestor = (element: unknown): boolean => {
    let parent = Reflect.get(element as object, "parent") as unknown;
    while (parent && typeof parent === "object") {
      if (selected.has(parent)) return true;
      parent = Reflect.get(parent, "parent") as unknown;
    }
    return false;
  };

  const scoreCandidate = (element: AnyNode): void => {
    const metrics = candidateMetrics(element);
    const quality = scoreContentCandidate({
      text: metrics.text,
      paragraphCount: metrics.paragraphCount,
      linkTextLength: metrics.linkTextLength,
    });
    if (quality.score > bestScore) {
      bestScore = quality.score;
      bestText = metrics.text;
    }
  };

  for (const element of candidateElements) {
    if (hasSelectedAncestor(element) || ancestorsOfSelected.has(element)) {
      continue;
    }
    selected.add(element);
    let parent = Reflect.get(element as object, "parent") as unknown;
    while (parent && typeof parent === "object") {
      ancestorsOfSelected.add(parent);
      parent = Reflect.get(parent, "parent") as unknown;
    }
    scoreCandidate(element);
  }

  // Specific semantic candidates are preferred to avoid repeatedly walking the
  // whole document. If all of them are too short, score body once as a fallback.
  if (bestText.length < minCharacters) {
    const body = $("body").first().get(0);
    if (body && !selected.has(body)) scoreCandidate(body);
  }

  if (bestText.length < minCharacters) {
    throw new LlmFetchError(
      "CONTENT_INSUFFICIENT",
      "The page did not contain enough readable text.",
      { url: finalUrl },
    );
  }

  const truncated = bestText.length > maxCharacters;
  const text = truncated ? bestText.slice(0, maxCharacters).trimEnd() : bestText;
  const result: ExtractedContent = {
    title: title || new URL(finalUrl).hostname,
    text,
    characterCount: bestText.length,
    truncated,
  };
  if (text) result.excerpt = text.slice(0, 240);
  return result;
}

export function extractPlainTextContent(
  rawText: string,
  finalUrl: string,
  options: ExtractContentOptions = {},
): ExtractedContent {
  const maxCharacters = options.maxCharacters ?? 20_000;
  const minCharacters = options.minCharacters ?? 20;
  const normalized = normalizePlainText(rawText);
  if (normalized.length < minCharacters) {
    throw new LlmFetchError(
      "CONTENT_INSUFFICIENT",
      "The response did not contain enough readable text.",
      { url: finalUrl },
    );
  }
  const truncated = normalized.length > maxCharacters;
  const text = truncated ? normalized.slice(0, maxCharacters).trimEnd() : normalized;
  return {
    title: new URL(finalUrl).hostname,
    text,
    characterCount: normalized.length,
    truncated,
    excerpt: text.slice(0, 240),
  };
}
