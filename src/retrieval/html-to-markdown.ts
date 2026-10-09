import { domNodeAttributes, domNodeChildren, domNodeData, domNodeName } from "./html-limits.js";
import {
  boundedMarkdown,
  codeFence,
  escapeMarkdownText,
  joinMarkdown,
  normalizeMarkdownBlocks,
} from "./markdown-output.js";
import { renderMarkdownTable } from "./markdown-table.js";
import { codeLanguage } from "./code-language.js";

const OMIT = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "object",
  "embed",
  "head",
  "meta",
  "link",
  "input",
  "textarea",
  "select",
  "button",
]);
const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "header",
  "footer",
  "aside",
  "figure",
  "figcaption",
  "details",
  "summary",
  "dl",
  "dt",
  "dd",
  "address",
]);

function textContent(node: unknown): string {
  const parts: string[] = [];
  const stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (current && Reflect.get(current, "type") === "text") parts.push(domNodeData(current));
    else stack.push(...[...domNodeChildren(current)].reverse());
  }
  return joinMarkdown(parts).replace(/\r\n?/g, "\n");
}

function linkDestination(value: string | undefined, finalUrl: string): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value, finalUrl);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return undefined;
    return url.href.replace(/[\s()<>\\]/g, (character) =>
      character === "(" ? "%28" : character === ")" ? "%29" : encodeURIComponent(character),
    );
  } catch {
    return undefined;
  }
}

function emphasis(content: string, delimiter: string): string {
  const text = content.trim();
  if (!text) return content;
  if (text.includes("\n") && /\n\s*\n|^`{3,}|^~{3,}/.test(text)) return content;
  const start = content.indexOf(text);
  return `${content.slice(0, start)}${delimiter}${text}${delimiter}${content.slice(start + text.length)}`;
}

export function htmlToMarkdown(
  node: unknown,
  finalUrl: string,
  options: { preserveMarkdownText?: boolean; restoreText?: (value: string) => string } = {},
): string {
  const renderChildren = (node: unknown): string => joinMarkdown(domNodeChildren(node).map(render));
  const render = (node: unknown): string => {
    if (!node || typeof node !== "object") return "";
    if (Reflect.get(node, "type") === "text") {
      const text = domNodeData(node);
      const parent = Reflect.get(node, "parent");
      const nativeMarkdown =
        !parent ||
        ["html", "body"].includes(domNodeName(parent)) ||
        Reflect.get(parent, "type") === "root";
      return options.preserveMarkdownText && nativeMarkdown
        ? text.replace(/</g, "&lt;")
        : escapeMarkdownText(options.preserveMarkdownText ? text : text.replace(/\s+/g, " "));
    }
    const name = domNodeName(node);
    if (OMIT.has(name) || Reflect.get(node, "type") === "comment") return "";
    const attributes = domNodeAttributes(node);
    if (name === "pre") {
      const language = codeLanguage(node);
      const text = textContent(node);
      return `\n\n${codeFence(options.restoreText?.(text) ?? text, language)}\n\n`;
    }
    if (name === "code") {
      const raw = textContent(node);
      const text = (options.restoreText?.(raw) ?? raw).replace(/\n/g, " ");
      if (!text) return "";
      const longest = [...text.matchAll(/`+/g)].reduce(
        (length, match) => Math.max(length, match[0].length),
        0,
      );
      const delimiter = "`".repeat(longest + 1);
      const pad =
        text.startsWith("`") || text.endsWith("`") || (/^ .* $/.test(text) && /[^ ]/.test(text))
          ? " "
          : "";
      return boundedMarkdown(`${delimiter}${pad}${text}${pad}${delimiter}`);
    }
    if (name === "table") return `\n\n${renderMarkdownTable(node, render)}\n\n`;
    if (name === "ul" || name === "ol") {
      const items: string[] = [];
      const reversed = Object.hasOwn(attributes, "reversed");
      const children = domNodeChildren(node).filter((child) => domNodeName(child) === "li");
      let number = Number.parseInt(attributes.start ?? String(reversed ? children.length : 1), 10);
      if (!Number.isSafeInteger(number)) number = 1;
      for (const child of children) {
        const override = Number.parseInt(domNodeAttributes(child).value ?? "", 10);
        if (Number.isSafeInteger(override)) number = override;
        const marker = name === "ol" ? `${number}. ` : "- ";
        const body = renderChildren(child).trim();
        const lines = body.split("\n");
        items.push(
          joinMarkdown(
            [
              marker + (lines[0] ?? ""),
              ...lines.slice(1).map((line) => (line ? " ".repeat(marker.length) + line : "")),
            ],
            "\n",
          ),
        );
        number += reversed ? -1 : 1;
      }
      return `\n\n${joinMarkdown(items, "\n")}\n\n`;
    }
    const content = renderChildren(node);
    if (/^h[1-6]$/.test(name)) {
      const heading = content.trim();
      if (/^`{3,}|^~{3,}|\n\s*\n/.test(heading)) return content;
      return `\n\n${"#".repeat(Number(name[1]))} ${heading.replace(/\n/g, " ")}\n\n`;
    }
    if (name === "br") return options.preserveMarkdownText ? "  \n" : "\n";
    if (name === "hr") return "\n\n---\n\n";
    if (name === "a") {
      const href = options.restoreText?.(attributes.href ?? "") ?? attributes.href;
      const destination = linkDestination(href, finalUrl);
      const heading = /^(#{1,6}) ([^\n]+)$/.exec(content.trim());
      if (heading && destination) return `\n\n${heading[1]} [${heading[2]}](${destination})\n\n`;
      if (/\n\s*\n|^`{3,}|^~{3,}|^\||^[-+*] |^\d{1,9}\. |^#{1,6} /.test(content.trim()))
        return destination ? `${content}\n\n[Link](${destination})\n\n` : content;
      const label = content.trim().replace(/\n+/g, " ");
      return destination && label ? `[${label}](${destination})` : content;
    }
    if (name === "img")
      return escapeMarkdownText(
        options.restoreText?.(attributes.alt ?? "") ?? attributes.alt ?? "",
      );
    if (name === "strong" || name === "b") return emphasis(content, "**");
    if (name === "em" || name === "i") return emphasis(content, "*");
    if (name === "s" || name === "del") return emphasis(content, "~~");
    if (name === "blockquote")
      return `\n\n${content
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`;
    if (name === "sup") return content ? `^(${content})` : "";
    if (name === "sub") return content ? `_(${content})` : "";
    return BLOCK.has(name) ? `\n\n${content.trim()}\n\n` : content;
  };
  const markdown = render(node);
  return boundedMarkdown(
    options.preserveMarkdownText ? markdown : normalizeMarkdownBlocks(markdown),
  );
}
