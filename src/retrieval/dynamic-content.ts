import type { CheerioAPI } from "cheerio";
import {
  domNodeAttributes,
  domNodeChildren,
  domNodeData,
  domNodeName,
} from "./html-limits.js";

const APP_ROOT_IDS = new Set(["__next", "__nuxt", "app", "root"]);
const EXCLUDED_TEXT_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
]);

function normalizedLength(value: string): number {
  return value.replace(/\s+/gu, " ").trim().length;
}

function appendBounded(current: string, value: string, maximum: number): string {
  if (current.length >= maximum) return current;
  const trimmed = value.trim();
  if (!trimmed) return current;
  const separator = current ? " " : "";
  const remaining = maximum - current.length - separator.length;
  if (remaining <= 0) return current;
  return `${current}${separator}${trimmed.slice(0, remaining)}`;
}

function isAppRoot(attributes: Readonly<Record<string, string>>): boolean {
  return (
    APP_ROOT_IDS.has(attributes.id ?? "") ||
    Object.hasOwn(attributes, "data-reactroot") ||
    Object.hasOwn(attributes, "data-v-app") ||
    Object.hasOwn(attributes, "ng-version")
  );
}

/** Collects all dynamic-page signals in one bounded, iterative DOM walk. */
export function isLikelyDynamicHtml($: CheerioAPI, rawHtml: string): boolean {
  const body = $("body").first().get(0);
  if (!body) return false;

  const stack: Array<{ node: unknown; excluded: boolean; appRoot: boolean }> = [
    { node: body, excluded: false, appRoot: false },
  ];
  let bodyText = "";
  let appRootText = "";
  let hasAppRoot = false;
  let hasExecutableScripts = false;
  let hasFrameworkPayload = false;
  let asksForJavaScript = false;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const name = domNodeName(current.node);
    const attributes = domNodeAttributes(current.node);
    const appRoot = current.appRoot || isAppRoot(attributes);
    if (appRoot) hasAppRoot = true;
    const excluded = current.excluded || EXCLUDED_TEXT_ELEMENTS.has(name);

    if (name === "script") {
      if (attributes.src || attributes.type?.toLowerCase() === "module") {
        hasExecutableScripts = true;
      }
      if (
        attributes.id === "__NEXT_DATA__" ||
        Object.hasOwn(attributes, "data-nuxt-data") ||
        attributes.type?.toLowerCase() === "application/json"
      ) {
        hasFrameworkPayload = true;
      }
    }
    if (name === "noscript") {
      const text = domNodeChildren(current.node)
        .map((child) => domNodeData(child))
        .join(" ");
      if (
        /(?:enable|require|turn on).{0,30}javascript|javascript.{0,30}(?:required|disabled)/iu.test(
          text,
        )
      ) {
        asksForJavaScript = true;
      }
    }
    if (!excluded) {
      const data = domNodeData(current.node);
      if (data) {
        bodyText = appendBounded(bodyText, data, 600);
        if (appRoot) appRootText = appendBounded(appRootText, data, 160);
      }
    }
    for (const child of domNodeChildren(current.node)) {
      stack.push({ node: child, excluded, appRoot });
    }
  }

  const bodyLength = normalizedLength(bodyText);
  if (bodyLength >= 500) return false;

  const hasEmptyAppRoot = hasAppRoot && normalizedLength(appRootText) < 120;
  hasFrameworkPayload ||= /(?:\/_next\/static\/|\/_nuxt\/|data-reactroot|data-v-app|ng-version)/iu.test(
    rawHtml,
  );

  return (
    (hasEmptyAppRoot && hasExecutableScripts) ||
    (hasFrameworkPayload && bodyLength < 200) ||
    (asksForJavaScript && bodyLength < 300)
  );
}
