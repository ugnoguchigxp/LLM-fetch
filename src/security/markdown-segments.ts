import { LlmFetchError } from "../errors.js";
import { normalizeMarkdownText } from "../retrieval/extract-markdown.js";
import { loadHtml } from "../retrieval/extract-content.js";
import { prepareHtmlForExtraction, type ContentSegment } from "./html-segments.js";

export interface MarkdownInspectionMaterial {
  visibleText: string;
  additionalSegments: ContentSegment[];
  omittedSegments: number;
}

function rethrowInspectionPreparation(error: unknown): never {
  if (error instanceof LlmFetchError && error.code === "RESPONSE_TOO_LARGE") throw error;
  throw new LlmFetchError(
    "GUARD_FAILED",
    "Untrusted content could not be prepared for inspection.",
  );
}

export function prepareMarkdownInspection(rawText: string): MarkdownInspectionMaterial {
  const visibleText = normalizeMarkdownText(rawText);
  if (!visibleText.includes("<")) {
    return { visibleText, additionalSegments: [], omittedSegments: 0 };
  }
  let prepared: ReturnType<typeof prepareHtmlForExtraction>;
  let projected = "";
  try {
    const $ = loadHtml(visibleText);
    prepared = prepareHtmlForExtraction($, visibleText, { inspectAllAttributes: true });
    projected = $("body").text();
  } catch (error) {
    rethrowInspectionPreparation(error);
  }
  const additionalSegments: ContentSegment[] = [];
  if (projected.length > 0) {
    additionalSegments.push({
      location: "visible",
      text: projected,
      truncated: false,
      originalLength: projected.length,
    });
  }
  additionalSegments.push(...prepared.segments);
  return {
    visibleText,
    additionalSegments,
    omittedSegments: prepared.omittedSegments,
  };
}
