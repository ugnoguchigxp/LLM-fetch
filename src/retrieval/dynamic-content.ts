import type { CheerioAPI } from "cheerio";

const APP_ROOT_SELECTORS = [
  "#__next",
  "#__nuxt",
  "#app",
  "#root",
  "[data-reactroot]",
  "[data-v-app]",
  "[ng-version]",
].join(",");

function normalizedLength(value: string): number {
  return value.replace(/\s+/gu, " ").trim().length;
}

export function isLikelyDynamicHtml($: CheerioAPI, rawHtml: string): boolean {
  const visibleBody = $("body").clone();
  visibleBody.find("script, style, noscript, template, svg").remove();
  const bodyLength = normalizedLength(visibleBody.text());
  if (bodyLength >= 500) return false;

  const appRoot = $(APP_ROOT_SELECTORS).first();
  const visibleAppRoot = appRoot.clone();
  visibleAppRoot.find("script, style, noscript, template, svg").remove();
  const hasEmptyAppRoot = appRoot.length > 0 && normalizedLength(visibleAppRoot.text()) < 120;
  const hasFrameworkPayload =
    $("script#__NEXT_DATA__, script[data-nuxt-data], script[type='application/json']").length > 0 ||
    /(?:\/_next\/static\/|\/_nuxt\/|data-reactroot|data-v-app|ng-version)/iu.test(rawHtml);
  const asksForJavaScript = $("noscript").toArray().some((element) =>
    /(?:enable|require|turn on).{0,30}javascript|javascript.{0,30}(?:required|disabled)/iu.test(
      $(element).text(),
    )
  );
  const hasExecutableScripts = $("script[src], script[type='module']").length > 0;

  return (
    (hasEmptyAppRoot && hasExecutableScripts) ||
    (hasFrameworkPayload && bodyLength < 200) ||
    (asksForJavaScript && bodyLength < 300)
  );
}
