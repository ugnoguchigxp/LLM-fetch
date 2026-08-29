import type { CheerioAPI } from "cheerio";
import type { SecurityFindingLocation } from "../contracts.js";

export interface ContentSegment {
  location: SecurityFindingLocation;
  text: string;
  truncated: boolean;
  originalLength: number;
}

export interface PreparedHtml {
  segments: ContentSegment[];
  excludedSummary: Record<string, number>;
  truncated: boolean;
  omittedSegments: number;
}

const MAX_SEGMENT_TEXT = 64_000;
const MAX_COLLECTED_SEGMENTS = 4_097;
const HIDDEN_STYLE_PATTERNS = [
  /(?:^|;)\s*display\s*:\s*none(?:\s*!important)?\s*(?:;|$)/i,
  /(?:^|;)\s*visibility\s*:\s*hidden(?:\s*!important)?\s*(?:;|$)/i,
  /(?:^|;)\s*content-visibility\s*:\s*hidden(?:\s*!important)?\s*(?:;|$)/i,
  /(?:^|;)\s*opacity\s*:\s*0(?:\.0+)?(?:\s*!important)?\s*(?:;|$)/i,
  /(?:^|;)\s*font-size\s*:\s*0(?:px|em|rem|%)?(?:\s*!important)?\s*(?:;|$)/i,
  /(?:^|;)\s*text-indent\s*:\s*-\d{3,}(?:px|em|rem)?(?:\s*!important)?\s*(?:;|$)/i,
  /(?:^|;)\s*transform\s*:\s*scale(?:x|y)?\s*\(\s*0(?:\.0+)?(?:\s*,\s*0(?:\.0+)?)?\s*\)(?:\s*!important)?\s*(?:;|$)/i,
];

function boundedText(text: string): Omit<ContentSegment, "location"> {
  const normalized = text.replace(/\s+/g, " ").trim();
  const originalLength = normalized.length;
  if (originalLength <= MAX_SEGMENT_TEXT) {
    return { text: normalized, truncated: false, originalLength };
  }
  const headLength = Math.ceil(MAX_SEGMENT_TEXT / 2);
  const tailLength = MAX_SEGMENT_TEXT - headLength;
  return {
    text: `${normalized.slice(0, headLength)}${normalized.slice(-tailLength)}`,
    truncated: true,
    originalLength,
  };
}

function appendSegment(
  segments: ContentSegment[],
  location: SecurityFindingLocation,
  bounded: Omit<ContentSegment, "location">,
): boolean {
  if (!bounded.text) return true;
  if (segments.length >= MAX_COLLECTED_SEGMENTS) return false;
  segments.push({ location, ...bounded });
  return true;
}

function inlineStyleIsHidden(style: string): boolean {
  const normalized = style.replace(/\s+/g, " ").trim();
  const explicitlyHidden = HIDDEN_STYLE_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
  const offscreen =
    /(?:^|;)\s*position\s*:\s*(?:absolute|fixed)\b/i.test(normalized) &&
    /(?:^|;)\s*(?:left|top|right|bottom)\s*:\s*(?:-\d{3,}|\d{4,})(?:px|em|rem)?\b/i.test(
      normalized,
    );
  const clipped =
    /(?:^|;)\s*clip(?:-path)?\s*:\s*(?:rect\s*\(\s*0|inset\s*\(\s*(?:50|100)%|circle\s*\(\s*0)/i.test(
      normalized,
    );
  return explicitlyHidden || offscreen || clipped;
}

function increment(summary: Record<string, number>, key: string): void {
  summary[key] = (summary[key] ?? 0) + 1;
}

export function prepareHtmlForExtraction(
  $: CheerioAPI,
  rawHtml: string,
): PreparedHtml {
  const segments: ContentSegment[] = [];
  const excludedSummary: Record<string, number> = {};
  let omittedSegments = 0;

  const collect = (
    location: SecurityFindingLocation,
    text: string,
  ): Omit<ContentSegment, "location"> => {
    const bounded = boundedText(text);
    if (!appendSegment(segments, location, bounded)) omittedSegments += 1;
    return bounded;
  };

  for (const match of rawHtml.matchAll(/<!--([\s\S]*?)-->/g)) {
    collect("comment", match[1] ?? "");
    increment(excludedSummary, "comment");
  }

  $("meta[content]").each((_index, element) => {
    collect("meta", $(element).attr("content") ?? "");
    increment(excludedSummary, "meta");
  });

  $("template").each((_index, element) => {
    collect("template", $(element).text());
    increment(excludedSummary, "template");
  });

  $("[aria-label], [title], [alt]").each((_index, element) => {
    for (const attribute of ["aria-label", "title", "alt"] as const) {
      const bounded = boundedText($(element).attr(attribute) ?? "");
      if (!bounded.text) continue;
      if (!appendSegment(segments, "attribute", bounded)) omittedSegments += 1;
      increment(excludedSummary, `attribute:${attribute}`);
    }
  });

  $("details:not([open])").each((_index, element) => {
    const node = $(element);
    const summary = node.children("summary").first().get(0);
    const hiddenParts: string[] = [];
    node.contents().each((_childIndex, child) => {
      if (summary && child === summary) return;
      hiddenParts.push($(child).text());
      $(child).remove();
    });
    const bounded = collect("hidden", hiddenParts.join(" "));
    if (bounded.text) increment(excludedSummary, "closed-details");
  });

  const hiddenElements = $(
    "[hidden], [inert], [aria-hidden], [style], input[type='hidden'], dialog:not([open])",
  )
    .filter((_index, element) => {
      const node = $(element);
      return (
        node.is("[hidden]") ||
        node.is("[inert]") ||
        node.is("dialog:not([open])") ||
        node.is("input[type='hidden']") ||
        node.attr("aria-hidden")?.toLowerCase() === "true" ||
        inlineStyleIsHidden(node.attr("style") ?? "")
      );
    })
    .toArray();

  const hiddenSet = new Set<object>(hiddenElements);
  const ancestryCache = new WeakMap<object, boolean>();
  const nestedUnderHidden = (element: object): boolean => {
    const path: object[] = [];
    let parent = Reflect.get(element, "parent") as object | null | undefined;
    let nested = false;
    while (parent && typeof parent === "object") {
      if (hiddenSet.has(parent)) {
        nested = true;
        break;
      }
      const cached = ancestryCache.get(parent);
      if (cached !== undefined) {
        nested = cached;
        break;
      }
      path.push(parent);
      parent = Reflect.get(parent, "parent") as object | null | undefined;
    }
    for (const ancestor of path) ancestryCache.set(ancestor, nested);
    return nested;
  };
  for (const element of hiddenElements) {
    const node = $(element);
    if (nestedUnderHidden(element)) continue;
    collect(
      "hidden",
      node.is("input[type='hidden']")
        ? (node.attr("value") ?? "")
        : node.text(),
    );
    increment(excludedSummary, "hidden-element");
    node.remove();
  }

  $(
    "script, style, noscript, template, svg, iframe, object, embed",
  ).remove();
  return {
    segments,
    excludedSummary,
    truncated:
      omittedSegments > 0 || segments.some((segment) => segment.truncated),
    omittedSegments,
  };
}
