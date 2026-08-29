import type {
  Browser,
  BrowserContext,
  CDPSession,
  Page,
  Request,
  Response as PlaywrightResponse,
  Route,
} from "playwright-core";
import type * as PlaywrightCore from "playwright-core";
import type {
  ContentRetrievalResult,
  ContentRetriever,
} from "../retrieval/content-retriever.js";
import { LlmFetchError, toLlmFetchError } from "../errors.js";
import {
  abortReason,
  isAbortSignal,
  waitWithSignal,
} from "../internal/abort-signal.js";
import { PACKAGE_VERSION } from "../internal/version.js";
import {
  defaultAddressResolver,
  resolveSafeOutboundUrl,
  type AddressResolver,
  type ResolvedAddress,
} from "../retrieval/outbound-policy.js";
import { BoundedGate } from "./bounded-gate.js";
import { createPinnedProxy, type PinnedProxy } from "./pinned-proxy.js";
import { renderedDomSnapshot } from "./rendered-dom-snapshot.js";

const ALLOWED_RESOURCE_TYPES = new Set([
  "document",
  "script",
  "stylesheet",
  "xhr",
  "fetch",
]);
const PLAYWRIGHT_LIMITATIONS = [
  "Browser JavaScript was executed in an isolated, non-persistent context.",
  "Browser routing and the pinned proxy are not an OS-level network sandbox.",
  "Embedded frames are blocked and shadow DOM is not included in extracted content.",
  "Rendered visibility analysis does not inspect images, canvas text, or color contrast completely.",
] as const;
const EXTERNAL_SANDBOX_LIMITATION =
  "Chromium process sandboxing was delegated to the deployment environment.";

export interface PlaywrightRetrieverOptions {
  concurrency?: number;
  maxQueue?: number;
  navigationTimeoutMs?: number;
  settleTimeoutMs?: number;
  maxRequests?: number;
  maxResponseBytes?: number;
  maxHtmlCharacters?: number;
  maxDomNodes?: number;
  dnsCacheTtlMs?: number;
  resolver?: AddressResolver;
  externalSandbox?: boolean;
  userAgent?: string;
}

interface NormalizedOptions {
  concurrency: number;
  maxQueue: number;
  navigationTimeoutMs: number;
  settleTimeoutMs: number;
  maxRequests: number;
  maxResponseBytes: number;
  maxHtmlCharacters: number;
  maxDomNodes: number;
  dnsCacheTtlMs: number;
  resolver: AddressResolver;
  externalSandbox: boolean;
  userAgent: string;
}

interface CachedResolution {
  expiresAt: number;
  promise: Promise<ResolvedAddress[]>;
}

type PlaywrightModule = typeof PlaywrightCore;

function withOptionalSignal<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return signal ? waitWithSignal(operation, signal) : operation;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function integerOption(
  value: number | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const normalized = value ?? fallback;
  if (
    !Number.isInteger(normalized) ||
    normalized < minimum ||
    normalized > maximum
  ) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return normalized;
}

function normalizeOptions(
  options: PlaywrightRetrieverOptions,
): NormalizedOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "Playwright options must be an object.",
    );
  }
  const resolver = options.resolver ?? defaultAddressResolver;
  if (typeof resolver !== "function") {
    throw new LlmFetchError("INVALID_INPUT", "resolver must be a function.");
  }
  const externalSandbox = options.externalSandbox ?? false;
  if (typeof externalSandbox !== "boolean") {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "externalSandbox must be a boolean.",
    );
  }
  const userAgent =
    options.userAgent ?? `llm-fetch-playwright/${PACKAGE_VERSION}`;
  if (
    typeof userAgent !== "string" ||
    !userAgent.trim() ||
    userAgent.length > 512 ||
    hasControlCharacters(userAgent)
  ) {
    throw new LlmFetchError("INVALID_INPUT", "userAgent is invalid.");
  }
  return {
    concurrency: integerOption(options.concurrency, 2, "concurrency", 1, 8),
    maxQueue: integerOption(options.maxQueue, 32, "maxQueue", 0, 1_000),
    navigationTimeoutMs: integerOption(
      options.navigationTimeoutMs,
      8_000,
      "navigationTimeoutMs",
      100,
      60_000,
    ),
    settleTimeoutMs: integerOption(
      options.settleTimeoutMs,
      750,
      "settleTimeoutMs",
      0,
      5_000,
    ),
    maxRequests: integerOption(
      options.maxRequests,
      100,
      "maxRequests",
      1,
      1_000,
    ),
    maxResponseBytes: integerOption(
      options.maxResponseBytes,
      5_000_000,
      "maxResponseBytes",
      100_000,
      50_000_000,
    ),
    maxHtmlCharacters: integerOption(
      options.maxHtmlCharacters,
      2_000_000,
      "maxHtmlCharacters",
      10_000,
      10_000_000,
    ),
    maxDomNodes: integerOption(
      options.maxDomNodes,
      100_000,
      "maxDomNodes",
      100,
      500_000,
    ),
    dnsCacheTtlMs: integerOption(
      options.dnsCacheTtlMs,
      1_000,
      "dnsCacheTtlMs",
      0,
      10_000,
    ),
    resolver,
    externalSandbox,
    userAgent,
  };
}

function moduleMissing(error: unknown): LlmFetchError {
  return new LlmFetchError(
    "CONFIG_MISSING",
    "Playwright retrieval requires playwright-core and an installed Chromium binary.",
    { cause: error },
  );
}

function browserExecutableMissing(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    /executable (?:does not exist|doesn't exist)/iu.test(error.message) ||
    /playwright(?:-core)? install/iu.test(error.message)
  );
}

function readableContentType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function responseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  // The browser has already decoded the navigation response and the rendered
  // DOM snapshot is encoded below with TextEncoder. Do not retain the original
  // response charset (or XHTML media type) for these new UTF-8 HTML bytes.
  const result: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
  };
  for (const name of ["content-language", "last-modified", "etag"]) {
    const value = headers[name];
    if (value && value.length <= 16_384) result[name] = value;
  }
  return result;
}

function browserRequestHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const result = Object.create(null) as Record<string, string>;
  let count = 0;
  let totalLength = 0;
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (name === "authorization" || name === "proxy-authorization") continue;
    count += 1;
    totalLength += name.length + value.length;
    if (
      count > 100 ||
      name.length > 100 ||
      value.length > 16_384 ||
      totalLength > 64 * 1024 ||
      hasControlCharacters(name) ||
      /[\r\n]/u.test(value)
    ) {
      throw new LlmFetchError(
        "RESPONSE_TOO_LARGE",
        "The browser request headers exceeded the safety limit.",
      );
    }
    result[name] = value;
  }
  return result;
}

function declaredResponseLength(headers: Record<string, string>): number {
  const value = headers["content-length"];
  if (value === undefined) return 0;
  if (!/^\d+$/u.test(value)) {
    throw new LlmFetchError(
      "UPSTREAM_HTTP",
      "Browser response content-length is invalid.",
    );
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new LlmFetchError(
      "RESPONSE_TOO_LARGE",
      "Browser response is too large.",
    );
  }
  return length;
}

async function validateNavigationResponse(
  response: PlaywrightResponse,
  maxResponseBytes: number,
  signal?: AbortSignal,
): Promise<{ status: number; headers: Record<string, string> }> {
  const status = response.status();
  if (status < 200 || status >= 300) {
    throw new LlmFetchError(
      "UPSTREAM_HTTP",
      `Browser navigation returned HTTP ${status}.`,
      {
        url: response.url(),
        status,
        retryable: status === 429 || status >= 500,
      },
    );
  }
  const headers = await withOptionalSignal(response.allHeaders(), signal);
  if (declaredResponseLength(headers) > maxResponseBytes) {
    throw new LlmFetchError(
      "RESPONSE_TOO_LARGE",
      "Browser response is too large.",
      { url: response.url() },
    );
  }
  const contentType = readableContentType(headers["content-type"] ?? "");
  if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
    throw new LlmFetchError(
      "UNSUPPORTED_CONTENT_TYPE",
      `Unsupported browser content type: ${contentType || "missing"}.`,
      { url: response.url() },
    );
  }
  return { status, headers };
}

export function monitorNetworkBudget(
  session: CDPSession,
  maxResponseBytes: number,
  onExceeded: (error: LlmFetchError) => void,
): void {
  interface RequestBytes {
    decoded: number;
    encoded: number;
    counted: number;
  }
  const requests = new Map<string, RequestBytes>();
  let totalBytes = 0;
  let exceeded = false;

  const failAccounting = () => {
    if (exceeded) return;
    exceeded = true;
    onExceeded(
      new LlmFetchError(
        "UPSTREAM_HTTP",
        "Chromium reported invalid network accounting data.",
      ),
    );
  };
  const updateTotal = (requestId: string, decoded: number, encoded: number) => {
    if (
      exceeded ||
      !Number.isFinite(decoded) ||
      decoded < 0 ||
      !Number.isFinite(encoded) ||
      encoded < 0
    ) {
      if (!exceeded) failAccounting();
      return;
    }
    const entry = requests.get(requestId) ?? {
      decoded: 0,
      encoded: 0,
      counted: 0,
    };
    entry.decoded += decoded;
    entry.encoded += encoded;
    const nextCounted = Math.max(entry.decoded, entry.encoded);
    totalBytes += nextCounted - entry.counted;
    entry.counted = nextCounted;
    requests.set(requestId, entry);
    if (
      !Number.isSafeInteger(entry.decoded) ||
      !Number.isSafeInteger(entry.encoded) ||
      !Number.isSafeInteger(totalBytes)
    ) {
      failAccounting();
      return;
    }
    if (totalBytes > maxResponseBytes) {
      exceeded = true;
      onExceeded(
        new LlmFetchError(
          "RESPONSE_TOO_LARGE",
          "The rendered page exceeded the total decoded or encoded network byte limit.",
        ),
      );
    }
  };

  session.on("Network.dataReceived", (event) => {
    updateTotal(event.requestId, event.dataLength, event.encodedDataLength);
  });
  session.on("Network.loadingFinished", (event) => {
    if (
      !Number.isFinite(event.encodedDataLength) ||
      event.encodedDataLength < 0
    ) {
      failAccounting();
      return;
    }
    const entry = requests.get(event.requestId);
    const encodedDelta = Math.max(
      0,
      event.encodedDataLength - (entry?.encoded ?? 0),
    );
    updateTotal(event.requestId, 0, encodedDelta);
    requests.delete(event.requestId);
  });
  session.on("Network.loadingFailed", (event) => {
    requests.delete(event.requestId);
  });
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

async function waitForRenderedContent(
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

export function playwrightRetriever(
  rawOptions: PlaywrightRetrieverOptions = {},
): ContentRetriever {
  const options = normalizeOptions(rawOptions);
  const gate = new BoundedGate(options.concurrency, options.maxQueue);
  const contexts = new Set<BrowserContext>();
  const dnsCache = new Map<string, CachedResolution>();
  let playwrightPromise: Promise<PlaywrightModule> | undefined;
  let proxyPromise: Promise<PinnedProxy> | undefined;
  let browserPromise: Promise<Browser> | undefined;
  let browserValue: Browser | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const loadPlaywright = () => {
    playwrightPromise ??= import("playwright-core").catch((error: unknown) => {
      throw moduleMissing(error);
    });
    return playwrightPromise;
  };

  const cachedResolver: AddressResolver = async (hostname) => {
    const now = Date.now();
    const existing = dnsCache.get(hostname);
    if (existing && existing.expiresAt >= now) return existing.promise;
    if (dnsCache.size >= 128)
      dnsCache.delete(dnsCache.keys().next().value as string);
    const promise = options
      .resolver(hostname)
      .then((addresses) => addresses.map((address) => ({ ...address })));
    dnsCache.set(hostname, { expiresAt: now + options.dnsCacheTtlMs, promise });
    try {
      return await promise;
    } catch (error) {
      if (dnsCache.get(hostname)?.promise === promise)
        dnsCache.delete(hostname);
      throw error;
    }
  };

  const ensureProxy = () => {
    proxyPromise ??= createPinnedProxy({
      resolver: options.resolver,
      connectTimeoutMs: options.navigationTimeoutMs,
      maxResponseBytes: options.maxResponseBytes,
    }).catch((error: unknown) => {
      proxyPromise = undefined;
      throw error;
    });
    return proxyPromise;
  };

  const ensureBrowser = async () => {
    if (closed)
      throw new LlmFetchError(
        "CONFIG_MISSING",
        "The Playwright retriever is closed.",
      );
    if (browserValue?.isConnected()) return browserValue;
    if (!browserPromise) {
      browserPromise = (async () => {
        const playwright = await loadPlaywright();
        const proxy = await ensureProxy();
        let browser: Browser;
        try {
          browser = await playwright.chromium.launch({
            headless: true,
            chromiumSandbox: !options.externalSandbox,
            proxy: {
              server: proxy.server,
              username: proxy.username,
              password: proxy.password,
            },
            args: [
              "--disable-quic",
              "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            ],
          });
        } catch (error) {
          await proxy.close().catch(() => undefined);
          proxyPromise = undefined;
          if (browserExecutableMissing(error)) throw moduleMissing(error);
          throw error;
        }
        browser.on("disconnected", () => {
          if (browserValue === browser) browserValue = undefined;
          browserPromise = undefined;
        });
        browserValue = browser;
        return browser;
      })().catch((error: unknown) => {
        browserPromise = undefined;
        throw error;
      });
    }
    return browserPromise;
  };

  const retrieve = async (
    url: string,
    input: { signal?: AbortSignal } = {},
  ): Promise<ContentRetrievalResult> => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new LlmFetchError(
        "INVALID_INPUT",
        "Playwright retrieval input must be an object.",
      );
    }
    if (input.signal !== undefined && !isAbortSignal(input.signal)) {
      throw new LlmFetchError(
        "INVALID_INPUT",
        "signal must be an AbortSignal.",
      );
    }
    const operationTimeout = AbortSignal.timeout(
      options.navigationTimeoutMs + options.settleTimeoutMs,
    );
    const signal = input.signal
      ? AbortSignal.any([input.signal, operationTimeout])
      : operationTimeout;
    try {
      return await gate.run(async () => {
        signal.throwIfAborted();
        if (closed) {
          throw new LlmFetchError(
            "CONFIG_MISSING",
            "The Playwright retriever is closed.",
          );
        }
        await withOptionalSignal(
          resolveSafeOutboundUrl(url, cachedResolver),
          signal,
        );
        const browser = await withOptionalSignal(ensureBrowser(), signal);
        let context: BrowserContext | undefined;
        let abortListener: (() => void) | undefined;
        let blockedError: LlmFetchError | undefined;
        try {
          const contextCreation = browser.newContext({
            acceptDownloads: false,
            bypassCSP: false,
            ignoreHTTPSErrors: false,
            javaScriptEnabled: true,
            permissions: [],
            serviceWorkers: "block",
            userAgent: options.userAgent,
            viewport: { width: 1280, height: 720 },
          });
          try {
            context = await withOptionalSignal(contextCreation, signal);
          } catch (error) {
            void contextCreation
              .then((createdContext) =>
                createdContext.close({ reason: "Retrieval aborted" }),
              )
              .catch(() => undefined);
            throw error;
          }
          contexts.add(context);
          abortListener = () => {
            void context
              ?.close({ reason: "Retrieval aborted" })
              .catch(() => undefined);
          };
          signal.addEventListener("abort", abortListener, { once: true });
          context.setDefaultNavigationTimeout(options.navigationTimeoutMs);
          context.setDefaultTimeout(options.navigationTimeoutMs);
          let requestCount = 0;

          await context.routeWebSocket("**/*", async (webSocket) => {
            await webSocket.close({
              code: 1008,
              reason: "WebSocket access is disabled",
            });
          });
          await context.route(
            "**/*",
            async (route: Route, request: Request) => {
              try {
                requestCount += 1;
                if (requestCount > options.maxRequests) {
                  blockedError ??= new LlmFetchError(
                    "RESPONSE_TOO_LARGE",
                    "The rendered page exceeded the request limit.",
                    { url: request.url() },
                  );
                  await route.abort("blockedbyclient");
                  return;
                }
                if (!ALLOWED_RESOURCE_TYPES.has(request.resourceType())) {
                  await route.abort("blockedbyclient");
                  return;
                }
                if (
                  request.resourceType() === "document" &&
                  request.frame().parentFrame()
                ) {
                  await route.abort("blockedbyclient");
                  return;
                }
                if (request.method() !== "GET" && request.method() !== "HEAD") {
                  await route.abort("blockedbyclient");
                  return;
                }
                await withOptionalSignal(
                  resolveSafeOutboundUrl(request.url(), cachedResolver),
                  signal,
                );
                const headers = browserRequestHeaders(
                  await request.allHeaders(),
                );
                await route.continue({ headers });
              } catch (error) {
                blockedError ??=
                  error instanceof LlmFetchError
                    ? error
                    : toLlmFetchError(error, {
                        code: "UNSAFE_URL",
                        message:
                          "The browser request was rejected by the outbound policy.",
                        url: request.url(),
                      });
                await route.abort("blockedbyclient").catch(() => undefined);
              }
            },
          );

          await context.addInitScript(() => {
            const blocked = () => {
              throw new DOMException(
                "Blocked by llm-fetch browser policy",
                "SecurityError",
              );
            };
            Object.defineProperty(globalThis, "WebSocket", { value: blocked });
            Object.defineProperty(globalThis, "EventSource", {
              value: blocked,
            });
            Object.defineProperty(globalThis, "RTCPeerConnection", {
              value: blocked,
            });
            Object.defineProperty(globalThis, "webkitRTCPeerConnection", {
              value: blocked,
            });
            Object.defineProperty(globalThis, "open", { value: () => null });
            if (typeof navigator.sendBeacon === "function") {
              Object.defineProperty(navigator, "sendBeacon", {
                value: () => false,
              });
            }
          });

          const page = await context.newPage();
          const cdp = await context.newCDPSession(page);
          await cdp.send("Network.enable");
          monitorNetworkBudget(cdp, options.maxResponseBytes, (error) => {
            blockedError ??= error;
            void context
              ?.close({ reason: "Network byte limit exceeded" })
              .catch(() => undefined);
          });
          context.on("page", (popup) => {
            if (popup !== page) void popup.close().catch(() => undefined);
          });
          page.on(
            "popup",
            (popup) => void popup.close().catch(() => undefined),
          );
          page.on(
            "download",
            (download) => void download.cancel().catch(() => undefined),
          );
          page.on(
            "dialog",
            (dialog) => void dialog.dismiss().catch(() => undefined),
          );
          let lastNavigationResponse: PlaywrightResponse | undefined;
          page.on("response", (candidate) => {
            const request = candidate.request();
            if (
              request.isNavigationRequest() &&
              request.frame() === page.mainFrame()
            ) {
              lastNavigationResponse = candidate;
            }
          });
          let response;
          try {
            response = await page.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: options.navigationTimeoutMs,
              signal,
            });
          } catch (error) {
            if (signal.aborted) throw abortReason(signal);
            if (blockedError) throw blockedError;
            throw error;
          }
          if (blockedError) throw blockedError;
          if (!response) {
            throw new LlmFetchError(
              "UPSTREAM_HTTP",
              "Browser navigation returned no response.",
              {
                url,
              },
            );
          }
          await validateNavigationResponse(
            response,
            options.maxResponseBytes,
            signal,
          );
          await waitForRenderedContent(
            page,
            cdp,
            options.settleTimeoutMs,
            options.maxDomNodes,
            options.maxHtmlCharacters,
            signal,
            () => blockedError,
          );
          if (blockedError) throw blockedError;
          const snapshot = await withOptionalSignal(
            renderedDomSnapshot(
              page,
              {
                maxHtmlCharacters: options.maxHtmlCharacters,
                maxDomNodes: options.maxDomNodes,
                evaluationTimeoutMs: Math.min(
                  5_000,
                  options.navigationTimeoutMs,
                ),
              },
              cdp,
            ),
            signal,
          );
          if (blockedError) throw blockedError;
          signal.throwIfAborted();
          const finalUrl = page.url();
          await withOptionalSignal(
            resolveSafeOutboundUrl(finalUrl, cachedResolver),
            signal,
          );
          const finalResponse = lastNavigationResponse ?? response;
          const { status, headers } = await validateNavigationResponse(
            finalResponse,
            options.maxResponseBytes,
            signal,
          );
          if (snapshot.html.length > options.maxResponseBytes) {
            throw new LlmFetchError(
              "RESPONSE_TOO_LARGE",
              "The rendered DOM exceeded the response byte limit.",
              { url: finalUrl },
            );
          }
          const body = new TextEncoder().encode(snapshot.html);
          if (body.byteLength > options.maxResponseBytes) {
            throw new LlmFetchError(
              "RESPONSE_TOO_LARGE",
              "The encoded rendered DOM exceeded the response byte limit.",
              { url: finalUrl },
            );
          }
          return {
            requestedUrl: url,
            finalUrl,
            status,
            contentType: "text/html",
            body,
            headers: responseHeaders(headers),
            fetchMethod: "playwright",
            limitations: options.externalSandbox
              ? [...PLAYWRIGHT_LIMITATIONS, EXTERNAL_SANDBOX_LIMITATION]
              : PLAYWRIGHT_LIMITATIONS,
          };
        } catch (error) {
          if (error instanceof LlmFetchError) throw error;
          if (blockedError) throw blockedError;
          if (signal.aborted) throw abortReason(signal);
          throw toLlmFetchError(error, {
            code: "UPSTREAM_HTTP",
            message: "Playwright content retrieval failed.",
            url,
            retryable: true,
          });
        } finally {
          if (abortListener) {
            signal.removeEventListener("abort", abortListener);
          }
          if (context) {
            contexts.delete(context);
            await context
              .close({ reason: "Retrieval complete" })
              .catch(() => undefined);
          }
        }
      }, signal);
    } catch (error) {
      if (input.signal?.aborted) throw abortReason(input.signal);
      if (operationTimeout.aborted) {
        throw new LlmFetchError(
          "TIMEOUT",
          "Playwright retrieval exceeded its deadline.",
          {
            url,
            retryable: true,
            cause: error,
          },
        );
      }
      throw error;
    }
  };

  return {
    name: "playwright",
    async isAvailable() {
      if (closed) return false;
      try {
        await ensureBrowser();
        return true;
      } catch {
        return false;
      }
    },
    retrieve,
    close() {
      closePromise ??= (async () => {
        closed = true;
        dnsCache.clear();
        await Promise.all(
          [...contexts].map((context) =>
            context
              .close({ reason: "Retriever closed" })
              .catch(() => undefined),
          ),
        );
        contexts.clear();
        const browser =
          browserValue ?? (await browserPromise?.catch(() => undefined));
        browserValue = undefined;
        browserPromise = undefined;
        if (browser?.isConnected())
          await browser.close().catch(() => undefined);
        const proxy = await proxyPromise?.catch(() => undefined);
        proxyPromise = undefined;
        if (proxy) await proxy.close();
      })();
      return closePromise;
    },
  };
}
