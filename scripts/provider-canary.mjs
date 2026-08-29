import { brave, duckDuckGo } from "../dist/index.js";

const mode = process.argv[2] ?? "duckduckgo";
if (mode !== "duckduckgo" && mode !== "brave") {
  throw new Error(`Unknown provider canary mode: ${mode}`);
}
if (mode === "brave" && !process.env.BRAVE_SEARCH_API_KEY?.trim()) {
  throw new Error(
    "BRAVE_SEARCH_API_KEY is required for the Brave provider canary.",
  );
}
const provider =
  mode === "brave"
    ? brave({ apiKey: process.env.BRAVE_SEARCH_API_KEY ?? "" })
    : duckDuckGo({ timeoutMs: 10_000 });

const hits = await provider.search({
  query: "site:example.com Example Domain",
  limit: 3,
  safeSearch: "strict",
  language: "en",
  region: "US",
});
if (hits.length === 0) {
  throw new Error(`${provider.name} canary returned no results.`);
}
process.stdout.write(
  `${JSON.stringify({ provider: provider.name, resultCount: hits.length })}\n`,
);
