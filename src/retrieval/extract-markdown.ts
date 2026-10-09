import type { ExtractedContent, ExtractContentOptions } from "./extract-content.js";
import { LlmFetchError } from "../errors.js";
import { markdownWithoutHtml } from "./markdown-html.js";
import { inlineCodeRanges, markdownCodeBlocks, replaceCodeRanges } from "./markdown-code.js";

export function normalizeMarkdownText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function limitMarkdownReturn(
  text: string,
  maxCharacters: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxCharacters) return { text, truncated: false };
  let end = maxCharacters;
  const boundary = text.charCodeAt(end - 1);
  if (boundary >= 0xd800 && boundary <= 0xdbff) end -= 1;
  if (end < 0) end = 0;
  if (text.includes("`")) {
    const blocks = markdownCodeBlocks(text);
    if (!blocks.some((block) => block.start < end && end <= block.end)) {
      const masked = replaceCodeRanges(text, blocks, (value) => value.replace(/[^\n]/g, " "));
      const span = inlineCodeRanges(masked).find((span) => span.start < end && end < span.end);
      if (span) {
        const delimiter = "`".repeat(span.delimiterLength!);
        let contentEnd = end - delimiter.length - 1;
        if (contentEnd <= span.start + delimiter.length) end = span.start;
        else {
          const last = text.charCodeAt(contentEnd - 1);
          if (last >= 0xd800 && last <= 0xdbff) contentEnd--;
          if (contentEnd <= span.start + delimiter.length)
            return { text: text.slice(0, span.start), truncated: true };
          const prefix = text.slice(0, contentEnd);
          return { text: prefix + (prefix.endsWith("`") ? " " : "") + delimiter, truncated: true };
        }
      }
    }
  }
  return { text: text.slice(0, end), truncated: true };
}

export function markdownExcerpt(text: string): string {
  return limitMarkdownReturn(text, 240).text;
}

export function extractMarkdownContent(
  rawText: string,
  finalUrl: string,
  options: ExtractContentOptions = {},
): ExtractedContent {
  const maxCharacters = options.maxCharacters ?? 20_000;
  const minCharacters = options.minCharacters ?? 20;
  const normalized = markdownWithoutHtml(normalizeMarkdownText(rawText), finalUrl);
  if (normalized.trim().length < minCharacters) {
    throw new LlmFetchError(
      "CONTENT_INSUFFICIENT",
      "The response did not contain enough readable text.",
      { url: finalUrl, reasonCode: "INSUFFICIENT_TEXT" },
    );
  }
  const limited = limitMarkdownReturn(normalized, maxCharacters);
  return {
    title: new URL(finalUrl).hostname,
    text: limited.text,
    characterCount: normalized.length,
    truncated: limited.truncated,
    excerpt: markdownExcerpt(limited.text),
  };
}
