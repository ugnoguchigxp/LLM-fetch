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
import { scoreContentMetrics } from "./quality.js";

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

interface CandidateRange {
  start: number;
  end: number;
}

interface IndexedCandidateMetrics {
  characterCount: number;
  paragraphCount: number;
  linkTextLength: number;
}

interface LinkInterval {
  start: number;
  end: number;
  textLength: number;
}

interface CandidateTextIndex {
  ranges: ReadonlyMap<AnyNode, CandidateRange>;
  metrics(range: CandidateRange): IndexedCandidateMetrics;
  text(range: CandidateRange): string;
}

const DIRECT_CANDIDATE_LIMIT = 4;

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

function candidateCoversBodyText(
  body: AnyNode,
  candidates: readonly AnyNode[],
): boolean {
  return candidates.some((candidate) => {
    const stack = [...domNodeChildren(body)];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || node === candidate) continue;
      const data = domNodeData(node);
      if (data && /\S/u.test(data)) return false;
      stack.push(...domNodeChildren(node));
    }
    return true;
  });
}

function lowerBound<T>(
  values: readonly T[],
  target: number,
  selector: (value: T) => number,
): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const value = values[middle];
    if (value !== undefined && selector(value) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function prefixSums(values: readonly number[]): number[] {
  const prefix = [0];
  for (const value of values) {
    prefix.push((prefix.at(-1) ?? 0) + value);
  }
  return prefix;
}

function normalizedGapLength(
  value: string,
  start: number,
  end: number,
): number {
  let newlineCount = 0;
  for (let index = start; index < end; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x0d) {
      newlineCount += 1;
      if (value.charCodeAt(index + 1) === 0x0a) index += 1;
    } else if (code === 0x0a) {
      newlineCount += 1;
    }
  }
  return newlineCount === 0 ? 1 : Math.min(2, newlineCount);
}

function isTextRunSeparator(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0b ||
    code === 0x0c ||
    code === 0x0d ||
    code === 0x20
  );
}

function buildCandidateTextIndex(
  $: CheerioAPI,
  candidates: ReadonlySet<AnyNode>,
): CandidateTextIndex {
  interface LinkCapture {
    start: number;
    textParts: string[];
  }
  type Entry = {
    phase: "enter" | "exit";
    node: unknown;
    activeLink?: LinkCapture;
    blockTextVersion?: number;
    candidate?: AnyNode;
    openedLink?: LinkCapture;
  };
  const root = $.root().get(0);
  const stack: Entry[] = root
    ? [{ phase: "enter", node: root }]
    : [];
  const textParts: string[] = [];
  const ranges = new Map<AnyNode, CandidateRange>();
  const paragraphPositions: number[] = [];
  const linkIntervals: LinkInterval[] = [];
  let textLength = 0;
  let textVersion = 0;

  const separator = (): void => {
    if (textParts.length > 0) {
      textParts.push("\n\n");
      textLength += 2;
    }
  };

  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    if (entry.phase === "exit") {
      if (entry.blockTextVersion !== undefined) {
        if (textVersion > entry.blockTextVersion) {
          paragraphPositions.push(textLength);
        }
        separator();
      }
      if (entry.openedLink) {
        const textLengthForLink = normalizeInlineText(
          entry.openedLink.textParts.join(" "),
        ).length;
        if (textLengthForLink > 0) {
          linkIntervals.push({
            start: entry.openedLink.start,
            end: textLength,
            textLength: textLengthForLink,
          });
        }
      }
      if (entry.candidate) {
        const range = ranges.get(entry.candidate);
        if (range) range.end = textLength;
      }
      continue;
    }

    const candidate = candidates.has(entry.node as AnyNode)
      ? entry.node as AnyNode
      : undefined;
    if (candidate) ranges.set(candidate, { start: textLength, end: textLength });
    const name = domNodeName(entry.node);
    const block = BLOCK_ELEMENTS.has(name);
    if (block) separator();
    let activeLink = entry.activeLink;
    let openedLink: LinkCapture | undefined;
    if (name === "a" && !activeLink) {
      openedLink = { start: textLength, textParts: [] };
      activeLink = openedLink;
    }
    const data = domNodeData(entry.node);
    if (data) {
      textParts.push(data);
      textLength += data.length;
      if (/\S/u.test(data)) textVersion += 1;
      activeLink?.textParts.push(data);
    }

    const children = domNodeChildren(entry.node);
    stack.push({
      phase: "exit",
      node: entry.node,
      ...(block ? { blockTextVersion: textVersion } : {}),
      ...(candidate ? { candidate } : {}),
      ...(openedLink ? { openedLink } : {}),
    });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        phase: "enter",
        node: children[index],
        ...(activeLink ? { activeLink } : {}),
      });
    }
  }

  const rawText = textParts.join("");
  const runStarts: number[] = [];
  const runEnds: number[] = [];
  const textPrefix = [0];
  const gapPrefix = [0];
  let runStart = -1;
  let previousRunEnd = -1;
  let textTotal = 0;
  let gapTotal = 0;
  const closeRun = (end: number): void => {
    if (previousRunEnd >= 0) {
      gapTotal += normalizedGapLength(rawText, previousRunEnd, runStart);
      gapPrefix.push(gapTotal);
    }
    runStarts.push(runStart);
    runEnds.push(end);
    textTotal += end - runStart;
    textPrefix.push(textTotal);
    previousRunEnd = end;
    runStart = -1;
  };
  for (let index = 0; index < rawText.length; index += 1) {
    if (isTextRunSeparator(rawText.charCodeAt(index))) {
      if (runStart >= 0) closeRun(index);
    } else if (runStart < 0) {
      runStart = index;
    }
  }
  if (runStart >= 0) closeRun(rawText.length);
  const paragraphCount = (range: CandidateRange): number => {
    const start = lowerBound(paragraphPositions, range.start, (value) => value);
    const end = lowerBound(paragraphPositions, range.end, (value) => value);
    return end - start;
  };
  const characterCount = (range: CandidateRange): number => {
    let start = lowerBound(runStarts, range.start, (value) => value);
    let end = lowerBound(runStarts, range.end, (value) => value);
    while (start < end) {
      const runStart = runStarts[start];
      const runEnd = runEnds[start];
      if (
        runStart !== undefined &&
        runEnd !== undefined &&
        rawText.slice(runStart, runEnd).trim()
      ) break;
      start += 1;
    }
    while (end > start) {
      const runStart = runStarts[end - 1];
      const runEnd = runEnds[end - 1];
      if (
        runStart !== undefined &&
        runEnd !== undefined &&
        rawText.slice(runStart, runEnd).trim()
      ) break;
      end -= 1;
    }
    if (start >= end) return 0;
    const firstStart = runStarts[start];
    const firstEnd = runEnds[start];
    const lastStart = runStarts[end - 1];
    const lastEnd = runEnds[end - 1];
    if (
      firstStart === undefined ||
      firstEnd === undefined ||
      lastStart === undefined ||
      lastEnd === undefined
    ) return 0;
    const firstText = rawText.slice(firstStart, firstEnd);
    if (start === end - 1) return firstText.trim().length;
    const lastText = rawText.slice(lastStart, lastEnd);
    const textCharacters =
      (textPrefix[end] ?? 0) -
      (textPrefix[start] ?? 0) -
      (firstText.length - firstText.trimStart().length) -
      (lastText.length - lastText.trimEnd().length);
    const gaps = (gapPrefix[end - 1] ?? 0) - (gapPrefix[start] ?? 0);
    return textCharacters + gaps;
  };
  const linkPrefix = prefixSums(linkIntervals.map((entry) => entry.textLength));
  const linkTextLength = (range: CandidateRange): number => {
    const start = lowerBound(linkIntervals, range.start, (entry) => entry.start);
    const end = lowerBound(linkIntervals, range.end, (entry) => entry.start);
    const count = end - start;
    if (count <= 0) return 0;
    const content = (linkPrefix[end] ?? 0) - (linkPrefix[start] ?? 0);
    return content + count - 1;
  };

  return {
    ranges,
    metrics(range) {
      return {
        characterCount: characterCount(range),
        paragraphCount: paragraphCount(range),
        linkTextLength: linkTextLength(range),
      };
    },
    text(range) {
      return normalizePlainText(rawText.slice(range.start, range.end));
    },
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
  let bestRange: CandidateRange | undefined;
  const candidateElements: AnyNode[] = [];
  const candidateSet = new Set<AnyNode>();

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

  if (candidateElements.length <= DIRECT_CANDIDATE_LIMIT) {
    let bodyCandidate: AnyNode | undefined;
    const nonBodyCandidates: AnyNode[] = [];
    const scoreDirectCandidate = (element: AnyNode): void => {
      const metrics = candidateMetrics(element);
      const quality = scoreContentMetrics({
        characterCount: metrics.text.length,
        paragraphCount: metrics.paragraphCount,
        linkTextLength: metrics.linkTextLength,
      });
      if (quality.score > bestScore) {
        bestScore = quality.score;
        bestText = metrics.text;
      }
    };
    for (const element of candidateElements) {
      if (domNodeName(element) === "body") {
        bodyCandidate = element;
      } else {
        nonBodyCandidates.push(element);
        scoreDirectCandidate(element);
      }
    }
    if (
      bodyCandidate &&
      !candidateCoversBodyText(bodyCandidate, nonBodyCandidates)
    ) {
      scoreDirectCandidate(bodyCandidate);
    }
  } else {
    const index = buildCandidateTextIndex($, candidateSet);
    for (const element of candidateElements) {
      const range = index.ranges.get(element);
      if (!range) continue;
      const metrics = index.metrics(range);
      const quality = scoreContentMetrics({
        characterCount: metrics.characterCount,
        paragraphCount: metrics.paragraphCount,
        linkTextLength: metrics.linkTextLength,
      });
      if (quality.score > bestScore) {
        bestScore = quality.score;
        bestRange = range;
      }
    }
    if (bestRange) bestText = index.text(bestRange);
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
