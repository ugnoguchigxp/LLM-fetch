import type { CDPSession, Page } from "playwright-core";
import { LlmFetchError } from "../errors.js";
import { waitWithSignal } from "../internal/abort-signal.js";

function withOptionalSignal<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return signal ? waitWithSignal(operation, signal) : operation;
}
function collectBoundedRenderedState(options: {
  maxDomNodes: number;
  maxTextCharacters: number;
}): {
  textLength: number;
  nodeCount: number;
  exceeded: boolean;
} {
  const root = document.body;
  if (!root) return { textLength: 0, nodeCount: 0, exceeded: false };
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT,
  );
  let textLength = 0;
  let nodeCount = 1;
  while (walker.nextNode()) {
    nodeCount += 1;
    if (nodeCount > options.maxDomNodes) {
      return { textLength, nodeCount, exceeded: true };
    }
    const node = walker.currentNode;
    if (node.nodeType === Node.TEXT_NODE) {
      textLength += node.nodeValue?.length ?? 0;
      if (textLength > options.maxTextCharacters) {
        return { textLength, nodeCount, exceeded: true };
      }
    }
  }
  return { textLength, nodeCount, exceeded: false };
}

function isRenderedState(
  value: unknown,
): value is ReturnType<typeof collectBoundedRenderedState> {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<ReturnType<typeof collectBoundedRenderedState>>;
  return (
    Number.isSafeInteger(state.textLength) &&
    (state.textLength ?? -1) >= 0 &&
    Number.isSafeInteger(state.nodeCount) &&
    (state.nodeCount ?? -1) >= 0 &&
    typeof state.exceeded === "boolean"
  );
}

export async function waitForRenderedContent(
  page: Page,
  session: CDPSession,
  timeoutMs: number,
  maxDomNodes: number,
  maxTextCharacters: number,
  signal: AbortSignal | undefined,
  policyError: () => LlmFetchError | undefined,
): Promise<void> {
  if (timeoutMs === 0) return;
  const expression = `(${collectBoundedRenderedState.toString()})(${JSON.stringify(
    { maxDomNodes, maxTextCharacters },
  )})`;
  const startedAt = performance.now();
  let previous = "";
  let stableCount = 0;
  while (performance.now() - startedAt < timeoutMs) {
    signal?.throwIfAborted();
    const blocked = policyError();
    if (blocked) throw blocked;
    // Refresh the isolated world for each sample because a page may navigate
    // again after DOMContentLoaded while it is settling.
    const frameTree = await withOptionalSignal(
      session.send("Page.getFrameTree"),
      signal,
    );
    const world = await withOptionalSignal(
      session.send("Page.createIsolatedWorld", {
        frameId: frameTree.frameTree.frame.id,
        worldName: "llm-fetch-rendered-settle",
        grantUniveralAccess: false,
      }),
      signal,
    );
    const evaluation = await withOptionalSignal(
      session.send("Runtime.evaluate", {
        expression,
        contextId: world.executionContextId,
        returnByValue: true,
        awaitPromise: false,
        includeCommandLineAPI: false,
        timeout: Math.max(100, Math.min(1_000, timeoutMs)),
        disableBreaks: true,
      }),
      signal,
    );
    if (evaluation.exceptionDetails || !isRenderedState(evaluation.result.value)) {
      throw new LlmFetchError(
        "GUARD_FAILED",
        "Rendered DOM settle inspection failed in the isolated browser world.",
        { url: page.url() },
      );
    }
    const state = evaluation.result.value;
    if (state.exceeded) {
      throw new LlmFetchError(
        "RESPONSE_TOO_LARGE",
        "The rendered DOM exceeded the settle inspection limit.",
        {
          url: page.url(),
        },
      );
    }
    const current = `${state.textLength}:${state.nodeCount}`;
    stableCount = current === previous ? stableCount + 1 : 0;
    if (stableCount >= 2) return;
    previous = current;
    const remaining = timeoutMs - (performance.now() - startedAt);
    if (remaining <= 0) return;
    await withOptionalSignal(
      new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(100, remaining)),
      ),
      signal,
    );
  }
}
