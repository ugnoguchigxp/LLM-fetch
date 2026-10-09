import { LlmFetchError } from "../errors.js";
import type { ContentSegment } from "../security/html-segments.js";
import { prepareHtmlForExtraction } from "../security/html-segments.js";
import { prepareMarkdownInspection } from "../security/markdown-segments.js";
import { isLikelyDynamicHtml } from "./dynamic-content.js";
import {
  extractMarkdownContent,
  limitMarkdownReturn,
  markdownExcerpt,
} from "./extract-markdown.js";
import { htmlToMarkdown } from "./html-to-markdown.js";
import {
  extractedFromSelection,
  loadHtml,
  loadXml,
  selectHtmlContent,
  selectPlainText,
  type ExtractedContent,
} from "./extract-content.js";

export interface PreparedRetrievedBody {
  visibleText: string;
  additionalSegments: ContentSegment[];
  omittedSegments: number;
  extracted?: ExtractedContent;
  extract?: () => ExtractedContent;
  pendingError?: LlmFetchError;
}

function inspectionFailure(error: unknown): never {
  if (error instanceof LlmFetchError && error.code === "RESPONSE_TOO_LARGE") throw error;
  if (error instanceof LlmFetchError && error.code !== "CONTENT_INSUFFICIENT") throw error;
  throw new LlmFetchError(
    "GUARD_FAILED",
    "Untrusted content could not be prepared for inspection.",
  );
}

function plainBody(
  rawText: string,
  finalUrl: string,
  maxCharacters: number | undefined,
  minCharacters: number,
): PreparedRetrievedBody {
  const normalized = selectPlainText(rawText);
  const pendingError =
    normalized.length < minCharacters
      ? new LlmFetchError(
          "CONTENT_INSUFFICIENT",
          "The response did not contain enough readable text.",
          { url: finalUrl, reasonCode: "INSUFFICIENT_TEXT" },
        )
      : undefined;
  return {
    visibleText: normalized,
    additionalSegments: [],
    omittedSegments: 0,
    ...(pendingError
      ? { pendingError }
      : {
          extracted: extractedFromSelection(
            { title: new URL(finalUrl).hostname, text: normalized },
            maxCharacters ?? 20_000,
          ),
        }),
  };
}

function htmlBody(
  decoded: string,
  finalUrl: string,
  maxCharacters: number | undefined,
  fetchMethod: "http" | "playwright",
): PreparedRetrievedBody {
  let $;
  try {
    $ = loadHtml(decoded);
  } catch (error) {
    inspectionFailure(error);
  }
  const likelyDynamic = fetchMethod === "http" && isLikelyDynamicHtml($, decoded);
  const prepared = prepareHtmlForExtraction($, decoded);
  const preExtractionVisible = $("body").text();
  try {
    const selected = selectHtmlContent($, finalUrl);
    const visibleText = `${selected.title}\n${selected.text}`;
    if (likelyDynamic && selected.text.length < 500) {
      return {
        visibleText,
        additionalSegments: prepared.segments,
        omittedSegments: prepared.omittedSegments,
        pendingError: new LlmFetchError(
          "CONTENT_INSUFFICIENT",
          "The page appears to require JavaScript rendering.",
          { url: finalUrl, reasonCode: "DYNAMIC_RENDERING_REQUIRED" },
        ),
      };
    }
    return {
      visibleText,
      additionalSegments: prepared.segments,
      omittedSegments: prepared.omittedSegments,
      extract: () => {
        const markdown = htmlToMarkdown(selected.element, finalUrl);
        const limited = limitMarkdownReturn(markdown, maxCharacters ?? 20_000);
        return {
          title: selected.title,
          text: limited.text,
          characterCount: markdown.length,
          truncated: limited.truncated,
          excerpt: markdownExcerpt(limited.text),
        };
      },
    };
  } catch (error) {
    if (!(error instanceof LlmFetchError) || error.code !== "CONTENT_INSUFFICIENT") throw error;
    const pendingError = likelyDynamic
      ? new LlmFetchError(
          "CONTENT_INSUFFICIENT",
          "The page appears to require JavaScript rendering.",
          { url: finalUrl, reasonCode: "DYNAMIC_RENDERING_REQUIRED" },
        )
      : error.reasonCode
        ? error
        : new LlmFetchError(error.code, error.message, {
            url: finalUrl,
            reasonCode: "INSUFFICIENT_TEXT",
            cause: error,
          });
    return {
      visibleText: preExtractionVisible,
      additionalSegments: prepared.segments,
      omittedSegments: prepared.omittedSegments,
      pendingError,
    };
  }
}

function markdownBody(
  decoded: string,
  finalUrl: string,
  maxCharacters: number | undefined,
): PreparedRetrievedBody {
  const material = prepareMarkdownInspection(decoded);
  const base = {
    visibleText: material.visibleText,
    additionalSegments: material.additionalSegments,
    omittedSegments: material.omittedSegments,
  };
  return {
    ...base,
    extract: () =>
      extractMarkdownContent(
        material.visibleText,
        finalUrl,
        maxCharacters === undefined ? {} : { maxCharacters },
      ),
  };
}

export function prepareRetrievedBody(input: {
  contentType: string;
  decoded: string;
  finalUrl: string;
  maxCharacters?: number;
  fetchMethod: "http" | "playwright";
}): PreparedRetrievedBody {
  if (input.contentType === "text/html" || input.contentType === "application/xhtml+xml") {
    return htmlBody(input.decoded, input.finalUrl, input.maxCharacters, input.fetchMethod);
  }
  if (input.contentType === "text/markdown") {
    return markdownBody(input.decoded, input.finalUrl, input.maxCharacters);
  }
  if (input.contentType === "application/xml" || input.contentType === "text/xml") {
    let visible = "";
    try {
      visible = loadXml(input.decoded).root().text();
    } catch (error) {
      inspectionFailure(error);
    }
    return plainBody(visible, input.finalUrl, input.maxCharacters, 20);
  }
  return plainBody(input.decoded, input.finalUrl, input.maxCharacters, 20);
}
