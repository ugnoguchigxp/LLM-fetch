import { LlmFetchError } from "../errors.js";

export const MAX_MARKDOWN_CHARACTERS = 2_000_000;

export function boundedMarkdown(value: string): string {
  if (value.length > MAX_MARKDOWN_CHARACTERS) {
    throw new LlmFetchError(
      "RESPONSE_TOO_LARGE",
      "The Markdown output exceeded the conversion limit.",
    );
  }
  return value;
}

export function joinMarkdown(parts: readonly string[], separator = ""): string {
  const length =
    parts.reduce((total, part) => total + part.length, 0) +
    Math.max(0, parts.length - 1) * separator.length;
  if (length > MAX_MARKDOWN_CHARACTERS) {
    throw new LlmFetchError(
      "RESPONSE_TOO_LARGE",
      "The Markdown output exceeded the conversion limit.",
    );
  }
  return parts.join(separator);
}

export function escapeMarkdownText(text: string): string {
  return boundedMarkdown(
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/[\\`*_[\]#]/g, "\\$&"),
  );
}

export function codeFence(text: string, language = ""): string {
  const longest = [...text.matchAll(/`+/g)].reduce(
    (length, match) => Math.max(length, match[0].length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return boundedMarkdown(`${fence}${language}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`);
}

export function normalizeMarkdownBlocks(value: string): string {
  let fence: string | undefined;
  let blank = 0;
  const lines: string[] = [];
  for (const line of value.split("\n")) {
    const marker = /^\s*(?:>\s*)*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (
        marker[1] &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2]?.trim()
      )
        fence = undefined;
    }
    if (!fence && !line.trim()) {
      if (++blank > 1) continue;
    } else blank = 0;
    lines.push(line);
  }
  return joinMarkdown(lines, "\n").trim();
}
