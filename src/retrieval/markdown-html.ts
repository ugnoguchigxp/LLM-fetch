import { randomUUID } from "node:crypto";
import { inlineCodeRanges, markdownCodeBlocks, replaceCodeRanges } from "./markdown-code.js";
import { loadHtml } from "./extract-content.js";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { boundedMarkdown, normalizeMarkdownBlocks } from "./markdown-output.js";
import { prepareHtmlForExtraction } from "../security/html-segments.js";

// Code ranges are shared with return truncation; HTML inspection still uses the original.
function protectCode(text: string, save: (value: string) => string): string {
  const blocks = replaceCodeRanges(text, markdownCodeBlocks(text), save);
  return replaceCodeRanges(blocks, inlineCodeRanges(blocks), save);
}

export function markdownWithoutHtml(text: string, finalUrl: string): string {
  if (!text.includes("<")) return text;
  const prefix = `LLMFETCH${randomUUID().replaceAll("-", "")}TOKEN`;
  const saved: string[] = [];
  const save = (value: string): string => {
    const marker = `${prefix}${saved.length}END`;
    saved.push(value);
    return marker;
  };
  let protectedText = protectCode(text, save);
  let tags = [
    ...protectedText.matchAll(
      /<\/?[a-z][\w:-]*(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>|<!--[\s\S]*?(?:-->|$)/gi,
    ),
  ];
  const insideTag = (offset: number): boolean => {
    let low = 0;
    let high = tags.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (tags[middle]!.index <= offset) low = middle + 1;
      else high = middle;
    }
    const tag = tags[low - 1];
    return !!tag && tag.index < offset && offset < tag.index + tag[0].length;
  };
  // Markdown autolinks and escaped opening brackets must not become HTML tags.
  protectedText = protectedText.replace(
    /<(?:https?:\/\/[^<>\s]+|mailto:[^<>\s]+|[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>/g,
    (match: string, offset: number) => (insideTag(offset) ? match : save(match)),
  );
  tags = [
    ...protectedText.matchAll(
      /<\/?[a-z][\w:-]*(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>|<!--[\s\S]*?(?:-->|$)/gi,
    ),
  ];
  protectedText = protectedText.replace(
    /(\\+)(<[^<>\n]*>|<)/g,
    (match: string, slashes: string, _bracket: string, offset: number) =>
      slashes.length % 2 && !insideTag(offset) ? save(match) : match,
  );
  if (!protectedText.includes("<")) return text;
  // Preserve Markdown entity spelling as literal text. HTML code elements need
  // normal HTML decoding; tag tokens consume attributes without hiding them.
  let entityCode: string | undefined;
  protectedText = protectedText.replace(
    /<\/?[a-z][\w:-]*(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>|<!--[\s\S]*?(?:-->|$)|&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi,
    (token) => {
      if (token.startsWith("<")) {
        const tag = /^<(\/?)(pre|code)(?=[\s>])/i.exec(token);
        if (tag) {
          const name = tag[2]!.toLowerCase();
          if (!entityCode && !tag[1]) entityCode = name;
          else if (entityCode === name && tag[1]) entityCode = undefined;
        }
        return token;
      }
      return entityCode ? token : save(token);
    },
  );
  const $ = loadHtml(protectedText);
  // Output filtering uses the same hidden-element policy. The client separately
  // inspects the original, including material removed by this transformation.
  prepareHtmlForExtraction($, protectedText);
  const restoreText = (value: string): string =>
    value.replace(
      new RegExp(`${prefix}(\\d+)END`, "g"),
      (_match, index: string) => saved[Number(index)] ?? "",
    );
  const formatted = normalizeMarkdownBlocks(
    htmlToMarkdown($("body").get(0), finalUrl, { preserveMarkdownText: true, restoreText }),
  );
  const restored = restoreText(formatted);
  return boundedMarkdown(restored);
}
