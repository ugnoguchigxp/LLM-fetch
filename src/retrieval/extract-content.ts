import { load, type CheerioAPI } from "cheerio";
import { LlmFetchError } from "../errors.js";
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

const BLOCK_SELECTORS = "h1, h2, h3, h4, p, li, blockquote, pre, td";

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

function decodeCharset(contentTypeHeader: string): string {
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentTypeHeader)?.[1];
  if (!charset) return "utf-8";
  const normalized = charset.toLowerCase();
  if (normalized === "utf8") return "utf-8";
  if (normalized === "shift-jis" || normalized === "sjis") return "shift_jis";
  return normalized;
}

export function decodeBody(body: Uint8Array, contentTypeHeader: string): string {
  const charset = decodeCharset(contentTypeHeader);
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(body);
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

export function loadHtml(html: string): CheerioAPI {
  return load(html);
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
  const seen = new Set<unknown>();

  for (const selector of CANDIDATE_SELECTORS) {
    $(selector).each((_index, element) => {
      if (seen.has(element)) return;
      seen.add(element);
      const node = $(element);
      const blocks = node.find(BLOCK_SELECTORS);
      const blockTexts = blocks
        .map((_blockIndex, block) => normalizeInlineText($(block).text()))
        .get()
        .filter((text) => text.length > 0);
      const text = normalizePlainText(
        blockTexts.length > 0 ? blockTexts.join("\n\n") : node.text(),
      );
      const quality = scoreContentCandidate({
        text,
        paragraphCount: blockTexts.length,
        linkTextLength: normalizeInlineText(node.find("a").text()).length,
      });
      if (quality.score > bestScore) {
        bestScore = quality.score;
        bestText = text;
      }
    });
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
