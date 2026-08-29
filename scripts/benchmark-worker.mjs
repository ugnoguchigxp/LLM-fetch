import {
  createBuiltinContextGuard,
  createLlmFetch,
  duckDuckGo,
} from "../dist/index.js";

const encoder = new TextEncoder();
const paragraph =
  "TypeScript retrieval uses bounded parsing and structured untrusted references. ";
const guardText = paragraph
  .repeat(Math.ceil(50_000 / paragraph.length))
  .slice(0, 50_000);
const articleParagraph = `<p>${paragraph.repeat(12)}</p>`;
const article = `<html><head><title>Benchmark</title></head><body><main>${articleParagraph.repeat(
  Math.ceil(1_000_000 / articleParagraph.length),
)}</main></body></html>`.slice(0, 1_000_000);
const duckQuery = "llm-fetch parser benchmark";
const duckVqd = "4-123456789012345678901234567890123456";
const duckPreload = new URL("https://links.duckduckgo.com/d.js");
duckPreload.searchParams.set("q", duckQuery);
duckPreload.searchParams.set("vqd", duckVqd);
const duckBootstrap = `<script>window.vqd="${duckVqd}";</script><script src="${duckPreload
  .toString()
  .replaceAll("&", "&amp;")}"></script>`;
const duckResults = [];
let duckPayload = "";
for (let index = 0; duckPayload.length < 50_000; index += 1) {
  duckResults.push({
    t: `Benchmark result ${index}`,
    a: "A signed fixture result containing bounded descriptive parser benchmark text.",
    i: "example.com",
    u: `https://example.com/benchmark-${index}`,
  });
  duckPayload = `DDG.pageLayout.load("d", ${JSON.stringify(duckResults)});`;
}
const duckProvider = duckDuckGo({
  maxResponseBytes: 100_000,
  fetch: async (url) =>
    new Response(
      String(url).startsWith("https://links.duckduckgo.com/")
        ? duckPayload
        : duckBootstrap,
      {
        headers: {
          "content-type": String(url).startsWith(
            "https://links.duckduckgo.com/",
          )
            ? "application/javascript"
            : "text/html",
        },
      },
    ),
});
const guard = createBuiltinContextGuard({ maxCharacters: 2_000_000 });
const client = createLlmFetch({
  cache: { enabled: false },
  contextGuard: { maxCharacters: 2_000_000 },
  fetcher: async (url) => ({
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    contentType: "text/html",
    body: encoder.encode(article),
    headers: { "content-type": "text/html; charset=utf-8" },
    fetchMethod: "http",
  }),
});

function percentile(sorted, value) {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * value) - 1),
  );
  return sorted[index];
}

async function measure(name, operation, thresholdMs, batchSize = 1) {
  for (let index = 0; index < 5; index += 1) await operation(index);
  const samples = [];
  for (let sample = 0; sample < 30; sample += 1) {
    const started = performance.now();
    for (let index = 0; index < batchSize; index += 1) {
      await operation(5 + sample * batchSize + index);
    }
    samples.push((performance.now() - started) / batchSize);
  }
  samples.sort((left, right) => left - right);
  return {
    name,
    samples: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
    thresholdMs,
    batchSize,
  };
}

try {
  const results = [
    await measure(
      "DuckDuckGo fixture 50 KiB",
      async () => {
        await duckProvider.search({ query: duckQuery, limit: 20 });
      },
      15,
      3,
    ),
    await measure(
      "Context Guard 50 KiB",
      async () => {
        await guard.inspectRaw({
          rawBody: encoder.encode(guardText),
          contentType: "text/plain; charset=utf-8",
          source: { kind: "unknown", trust: "untrusted" },
          requestedUse: "answer_with_citation",
        });
      },
      10,
      5,
    ),
    await measure(
      "HTML 1 MiB extraction and guard",
      async (index) => {
        await client.read({ url: `https://example.com/benchmark-${index}` });
      },
      75,
      2,
    ),
  ];
  process.stdout.write(`${JSON.stringify({ node: process.version, results })}\n`);
} finally {
  await client.close();
}
