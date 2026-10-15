import { LlmFetchError } from "../errors.js";
import { boundedText, MAX_COLLECTED_SEGMENTS, type ContentSegment } from "./html-segments.js";
import { prepareMarkdownInspection } from "./markdown-segments.js";

// JSON adapters must inspect decoded fields, including fields not used in output.
// Use the existing HTML projection and collection ceiling; never silently skip
// escaped directives, markup attributes, or an oversized/deep response.
export function prepareJsonInspection(decoded: string, maxCharacters?: number) {
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    throw new LlmFetchError("GUARD_FAILED", "Invalid JSON inspection material.");
  }
  const segments: ContentSegment[] = [];
  const stack: unknown[] = [value];
  let visited = 0;
  let omittedSegments = 0;
  while (stack.length > 0) {
    if (++visited > MAX_COLLECTED_SEGMENTS || segments.length >= MAX_COLLECTED_SEGMENTS) {
      omittedSegments += 1;
      break;
    }
    const item = stack.pop();
    if (item && typeof item === "object") {
      const entries = Object.entries(item);
      if (entries.length * 2 + stack.length > MAX_COLLECTED_SEGMENTS) {
        omittedSegments += 1;
        break;
      }
      for (const [key, child] of entries) stack.push(key, child);
      continue;
    }
    const material = prepareMarkdownInspection(String(item), maxCharacters);
    const text = material.visibleText;
    if (text) {
      segments.push({
        location: "visible",
        ...boundedText(text, maxCharacters),
        structuralLines: true,
      });
    }
    omittedSegments += material.omittedSegments;
    for (const segment of material.additionalSegments) {
      if (segments.length >= MAX_COLLECTED_SEGMENTS) {
        omittedSegments += 1;
        break;
      }
      segments.push(segment);
    }
  }
  return { visibleText: "", additionalSegments: segments, omittedSegments };
}
