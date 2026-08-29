const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "ref_src",
]);

export function unwrapDuckDuckGoUrl(rawUrl: string): string {
  const normalized = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
  let url: URL;
  try {
    url = new URL(normalized, "https://duckduckgo.com");
  } catch {
    return rawUrl;
  }

  if (
    (url.hostname === "duckduckgo.com" ||
      url.hostname.endsWith(".duckduckgo.com")) &&
    url.pathname.startsWith("/l/")
  ) {
    const destination = url.searchParams.get("uddg");
    if (destination) return destination;
  }
  return url.toString();
}

export function normalizeResultUrl(rawUrl: string): string | null {
  const unwrapped = unwrapDuckDuckGoUrl(rawUrl);
  let url: URL;
  try {
    url = new URL(unwrapped);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  url.hash = "";

  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

export function deduplicateSearchUrls<T extends { url: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const normalized = normalizeResultUrl(item.url);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({ ...item, url: normalized });
  }
  return result;
}
