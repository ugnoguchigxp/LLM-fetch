import type { CDPSession, Page } from "playwright-core";
import { LlmFetchError } from "../errors.js";

export interface RenderedDomSnapshotOptions {
  maxHtmlCharacters: number;
  maxDomNodes: number;
  evaluationTimeoutMs?: number;
}

export interface RenderedDomSnapshot {
  html: string;
  nodeCount: number;
}

interface BrowserSnapshotResult {
  html: string;
  nodeCount: number;
  exceeded: boolean;
}

function collectRenderedDomSnapshot(options: {
  maxHtmlCharacters: number;
  maxDomNodes: number;
}): BrowserSnapshotResult {
  const { maxHtmlCharacters, maxDomNodes } = options;
  const root = document.documentElement;
  if (!root) return { html: "", nodeCount: 0, exceeded: false };
  const originalBody = document.body;
  const originalElements = Array.from(root.querySelectorAll("*"));
  const allNodes = originalElements.length + 1;
  if (allNodes > maxDomNodes) {
    return { html: "", nodeCount: allNodes, exceeded: true };
  }

  let estimatedHtmlCharacters = 32;
  const addEscapedLength = (value: string, attribute: boolean): boolean => {
    const remaining = maxHtmlCharacters - estimatedHtmlCharacters;
    if (value.length > remaining) return false;
    let length = value.length;
    for (const character of value) {
      if (character === "&") length += 4;
      else if (character === "<" || character === ">") length += 3;
      else if (attribute && character === '"') length += 5;
      if (length > remaining) return false;
    }
    estimatedHtmlCharacters += length;
    return true;
  };

  for (const element of [root, ...originalElements]) {
    estimatedHtmlCharacters += element.tagName.length * 2 + 5;
    if (estimatedHtmlCharacters > maxHtmlCharacters) {
      return { html: "", nodeCount: allNodes, exceeded: true };
    }
    for (const attribute of element.attributes) {
      estimatedHtmlCharacters += attribute.name.length + 4;
      if (
        estimatedHtmlCharacters > maxHtmlCharacters ||
        !addEscapedLength(attribute.value, true)
      ) {
        return { html: "", nodeCount: allNodes, exceeded: true };
      }
    }
  }
  const textWalker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT,
  );
  while (textWalker.nextNode()) {
    if (!addEscapedLength(textWalker.currentNode.nodeValue ?? "", false)) {
      return { html: "", nodeCount: allNodes, exceeded: true };
    }
  }

  const cloneRoot = root.cloneNode(true) as HTMLElement;
  const cloneBody = cloneRoot.querySelector("body");

  if (originalBody && cloneBody) {
    const originals: Element[] = [
      originalBody,
      ...originalBody.querySelectorAll("*"),
    ];
    const clones: Element[] = [cloneBody, ...cloneBody.querySelectorAll("*")];
    const count = Math.min(originals.length, clones.length);
    for (let index = 0; index < count; index += 1) {
      const original = originals[index];
      const clone = clones[index];
      if (!original || !clone) continue;
      const style = getComputedStyle(original);
      const opacity = Number.parseFloat(style.opacity || "1");
      const fontSize = Number.parseFloat(style.fontSize || "16");
      const textIndent = Number.parseFloat(style.textIndent || "0");
      const bounds = original.getBoundingClientRect();
      const positionedOffscreen =
        (style.position === "absolute" || style.position === "fixed") &&
        (bounds.right < -100 ||
          bounds.bottom < -100 ||
          bounds.left > globalThis.innerWidth + 100 ||
          bounds.top > globalThis.innerHeight + 100);
      const clipped =
        (style.clip !== "auto" && /rect\(\s*0(?:px)?[, ]/iu.test(style.clip)) ||
        (style.clipPath !== "none" &&
          /(?:inset\(\s*(?:50|100)%|circle\(\s*0)/iu.test(style.clipPath));
      const collapsedTransform =
        style.transform !== "none" &&
        bounds.width <= 0.1 &&
        bounds.height <= 0.1 &&
        Boolean(original.textContent?.trim());
      const tinyClippedText =
        (style.overflow === "hidden" || style.overflow === "clip") &&
        bounds.width <= 1 &&
        bounds.height <= 1 &&
        Boolean(original.textContent?.trim());
      const nearestClosedDetails = original.closest("details:not([open])");
      let hiddenByClosedDetails = false;
      if (nearestClosedDetails && original !== nearestClosedDetails) {
        const summary = Array.from(nearestClosedDetails.children).find(
          (child) => child.tagName.toLowerCase() === "summary",
        );
        hiddenByClosedDetails =
          !summary || (original !== summary && !summary.contains(original));
      }
      const explicitlyHidden =
        original.hasAttribute("hidden") ||
        original.hasAttribute("inert") ||
        original.getAttribute("aria-hidden")?.toLowerCase() === "true" ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.contentVisibility === "hidden" ||
        (Number.isFinite(opacity) && opacity <= 0.01) ||
        (Number.isFinite(fontSize) && fontSize <= 0.1) ||
        (Number.isFinite(textIndent) && textIndent <= -1_000) ||
        positionedOffscreen ||
        clipped ||
        collapsedTransform ||
        tinyClippedText ||
        hiddenByClosedDetails;
      if (explicitlyHidden) {
        clone.setAttribute("hidden", "");
        clone.setAttribute("data-llm-fetch-computed-hidden", "true");
      }
    }

    for (const details of cloneBody.querySelectorAll("details:not([open])")) {
      const summary = Array.from(details.children).find(
        (child) => child.tagName.toLowerCase() === "summary",
      );
      const directHiddenText: string[] = [];
      for (const child of Array.from(details.childNodes)) {
        if (child === summary || child.nodeType !== Node.TEXT_NODE) continue;
        if (child.nodeValue?.trim()) directHiddenText.push(child.nodeValue);
        child.remove();
      }
      if (directHiddenText.length > 0) {
        const hiddenText = document.createElement("span");
        hiddenText.hidden = true;
        hiddenText.setAttribute("data-llm-fetch-computed-hidden", "true");
        hiddenText.textContent = directHiddenText.join(" ");
        details.append(hiddenText);
      }
    }
  }

  const doctype = document.doctype
    ? `<!DOCTYPE ${document.doctype.name}>`
    : "<!DOCTYPE html>";
  const html = `${doctype}${cloneRoot.outerHTML}`;
  return {
    html: html.length > maxHtmlCharacters ? "" : html,
    nodeCount: allNodes,
    exceeded: html.length > maxHtmlCharacters,
  };
}

function isBrowserSnapshotResult(
  value: unknown,
): value is BrowserSnapshotResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<BrowserSnapshotResult>;
  return (
    typeof result.html === "string" &&
    typeof result.nodeCount === "number" &&
    Number.isSafeInteger(result.nodeCount) &&
    result.nodeCount >= 0 &&
    typeof result.exceeded === "boolean"
  );
}

export async function renderedDomSnapshot(
  page: Page,
  options: RenderedDomSnapshotOptions,
  existingSession?: CDPSession,
): Promise<RenderedDomSnapshot> {
  if (
    !options ||
    typeof options !== "object" ||
    !Number.isInteger(options.maxHtmlCharacters) ||
    options.maxHtmlCharacters < 1 ||
    options.maxHtmlCharacters > 10_000_000 ||
    !Number.isInteger(options.maxDomNodes) ||
    options.maxDomNodes < 1 ||
    options.maxDomNodes > 500_000
  ) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "Rendered DOM snapshot limits are invalid.",
    );
  }
  const evaluationTimeoutMs = options.evaluationTimeoutMs ?? 5_000;
  if (
    !Number.isInteger(evaluationTimeoutMs) ||
    evaluationTimeoutMs < 100 ||
    evaluationTimeoutMs > 60_000
  ) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "evaluationTimeoutMs must be an integer between 100 and 60000.",
    );
  }

  const session = existingSession ?? (await page.context().newCDPSession(page));
  try {
    const frameTree = await session.send("Page.getFrameTree");
    const world = await session.send("Page.createIsolatedWorld", {
      frameId: frameTree.frameTree.frame.id,
      worldName: "llm-fetch-rendered-snapshot",
      grantUniveralAccess: false,
    });
    const expression = `(${collectRenderedDomSnapshot.toString()})(${JSON.stringify(
      {
        maxHtmlCharacters: options.maxHtmlCharacters,
        maxDomNodes: options.maxDomNodes,
      },
    )})`;
    const evaluation = await session.send("Runtime.evaluate", {
      expression,
      contextId: world.executionContextId,
      returnByValue: true,
      awaitPromise: false,
      includeCommandLineAPI: false,
      timeout: evaluationTimeoutMs,
      disableBreaks: true,
    });
    if (evaluation.exceptionDetails) {
      throw new LlmFetchError(
        "GUARD_FAILED",
        "Rendered DOM inspection failed in the isolated browser world.",
      );
    }
    const snapshot: unknown = evaluation.result.value;
    if (!isBrowserSnapshotResult(snapshot)) {
      throw new LlmFetchError(
        "GUARD_FAILED",
        "Rendered DOM inspection returned an invalid result.",
      );
    }
    if (
      snapshot.exceeded ||
      snapshot.html.length > options.maxHtmlCharacters ||
      snapshot.nodeCount > options.maxDomNodes
    ) {
      throw new LlmFetchError(
        "RESPONSE_TOO_LARGE",
        "The rendered DOM exceeded the configured safety limit.",
        { url: page.url() },
      );
    }
    if (!snapshot.html) {
      throw new LlmFetchError(
        "CONTENT_INSUFFICIENT",
        "The rendered page had no DOM content.",
        { url: page.url() },
      );
    }
    return { html: snapshot.html, nodeCount: snapshot.nodeCount };
  } catch (error) {
    if (error instanceof LlmFetchError) throw error;
    throw new LlmFetchError("GUARD_FAILED", "Rendered DOM inspection failed.", {
      url: page.url(),
      cause: error,
    });
  } finally {
    if (!existingSession) await session.detach().catch(() => undefined);
  }
}
