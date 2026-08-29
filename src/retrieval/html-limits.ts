import type { CheerioAPI } from "cheerio";
import { LlmFetchError } from "../errors.js";

export interface HtmlStructureLimits {
  maxDepth?: number;
  maxNodes?: number;
  maxCandidates?: number;
}

export const DEFAULT_HTML_STRUCTURE_LIMITS = {
  maxDepth: 512,
  maxNodes: 100_000,
  maxCandidates: 512,
} as const;

interface DomNodeLike {
  type?: string;
  name?: string;
  data?: string;
  children?: DomNodeLike[];
  parent?: DomNodeLike | null;
  attribs?: Record<string, string>;
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const HTML_TEXT_ELEMENTS = new Set([
  "iframe",
  "noembed",
  "noframes",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);

function limitError(message: string): LlmFetchError {
  return new LlmFetchError("RESPONSE_TOO_LARGE", message);
}

/**
 * Performs a non-recursive, conservative preflight before the HTML parser runs.
 * Parsed-tree limits are checked again after parsing because HTML error recovery
 * may produce a structure that differs from the source tag stream.
 */
export function assertHtmlSourceWithinLimits(
  html: string,
  limits: HtmlStructureLimits = {},
  xmlMode = false,
): void {
  const maxDepth = limits.maxDepth ?? DEFAULT_HTML_STRUCTURE_LIMITS.maxDepth;
  const maxNodes = limits.maxNodes ?? DEFAULT_HTML_STRUCTURE_LIMITS.maxNodes;
  const stack: string[] = [];
  let nodeCount = 0;
  let cursor = 0;

  while (cursor < html.length) {
    const opening = html.indexOf("<", cursor);
    if (opening < 0) break;
    if (html.startsWith("<!--", opening)) {
      const end = html.indexOf("-->", opening + 4);
      cursor = end < 0 ? html.length : end + 3;
      nodeCount += 1;
      if (nodeCount > maxNodes) {
        throw limitError("The HTML response exceeded the node limit.");
      }
      continue;
    }
    const closing = html.indexOf(">", opening + 1);
    if (closing < 0) break;
    const token = html.slice(opening + 1, closing).trim();
    cursor = closing + 1;
    if (!token) continue;
    if (token.startsWith("!") || token.startsWith("?")) {
      nodeCount += 1;
      if (nodeCount > maxNodes) {
        throw limitError("The HTML response exceeded the node limit.");
      }
      continue;
    }

    const isClosing = token.startsWith("/");
    const name = /^\/?\s*([a-z][\w:-]*)/iu.exec(token)?.[1]?.toLowerCase();
    if (!name) continue;
    if (isClosing) {
      const index = stack.lastIndexOf(name);
      if (index >= 0) stack.length = index;
      continue;
    }

    nodeCount += 1;
    if (nodeCount > maxNodes) {
      throw limitError("The HTML response exceeded the node limit.");
    }
    const selfClosing = xmlMode
      ? /\/\s*$/u.test(token)
      : VOID_ELEMENTS.has(name);
    if (!selfClosing) {
      stack.push(name);
      if (stack.length > maxDepth) {
        throw limitError("The HTML response exceeded the nesting-depth limit.");
      }
    }

    if (!xmlMode && name === "plaintext") {
      // In HTML, plaintext consumes the rest of the source as text.
      cursor = html.length;
    } else if (!xmlMode && HTML_TEXT_ELEMENTS.has(name)) {
      // HTML raw-text and RCDATA elements do not parse nested-looking markup.
      // XML has no such rule, so its contents must continue through preflight.
      const endPattern = new RegExp(`<\\/\\s*${name}\\s*>`, "igu");
      endPattern.lastIndex = cursor;
      const match = endPattern.exec(html);
      if (match) {
        cursor = endPattern.lastIndex;
        stack.pop();
      } else {
        cursor = html.length;
      }
    }
  }
}

export function assertParsedHtmlWithinLimits(
  $: CheerioAPI,
  limits: HtmlStructureLimits = {},
): void {
  const maxDepth = limits.maxDepth ?? DEFAULT_HTML_STRUCTURE_LIMITS.maxDepth;
  const maxNodes = limits.maxNodes ?? DEFAULT_HTML_STRUCTURE_LIMITS.maxNodes;
  const root = $.root().get(0) as unknown as DomNodeLike | undefined;
  const stack = (root?.children ?? []).map((node) => ({ node, depth: 1 }));
  let nodeCount = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodeCount += 1;
    if (nodeCount > maxNodes) {
      throw limitError("The parsed HTML exceeded the node limit.");
    }
    if (current.depth > maxDepth) {
      throw limitError("The parsed HTML exceeded the nesting-depth limit.");
    }
    for (const child of current.node.children ?? []) {
      stack.push({ node: child, depth: current.depth + 1 });
    }
  }
}

export function domNodeName(node: unknown): string {
  const value = node as DomNodeLike;
  return typeof value.name === "string" ? value.name.toLowerCase() : "";
}

export function domNodeChildren(node: unknown): readonly unknown[] {
  const children = (node as DomNodeLike).children;
  return Array.isArray(children) ? children : [];
}

export function domNodeData(node: unknown): string {
  const data = (node as DomNodeLike).data;
  return typeof data === "string" ? data : "";
}

export function domNodeAttributes(node: unknown): Readonly<Record<string, string>> {
  return (node as DomNodeLike).attribs ?? {};
}
