import assert from "node:assert/strict";
import { test } from "node:test";
import { diverseScenarios } from "../diverse.ts";
import { scenarios, validateScenarios } from "../scenarios.ts";
import { fixtureClient, fixtureSets } from "../fixtures.ts";

await test("additive diversity cohort has four real-site cases and nine controlled cases without replacing the original twenty", () => {
  assert.equal(validateScenarios([...scenarios, ...diverseScenarios]).length, 33);
  assert.equal(scenarios.length, 20);
  assert.equal(diverseScenarios.filter((s) => s.mode === "live").length, 4);
  assert.equal(diverseScenarios.filter((s) => s.mode === "fixture").length, 9);
  for (const s of diverseScenarios) {
    if (s.fixture) assert.ok(fixtureSets[s.fixture]?.length);
    else assert.ok(s.referenceUrls.length);
  }
});

await test("new controlled sources pass actual extraction with their content and units intact", async () => {
  for (const s of diverseScenarios.filter(
    (s) => s.fixture && s.fixture !== "slow-leading-pair" && s.fixture !== "short-html-fact",
  )) {
    const client = fixtureClient(s.fixture!, new AbortController().signal, async () => ({
      decision: "source_content",
    }));
    try {
      const hits = await client.search({
        query: "Provider replay does not match question words",
        limit: 10,
      });
      assert.equal(hits.length, fixtureSets[s.fixture!]!.length);
      for (const hit of hits) {
        const d = await client.read({ url: hit.url, maxCharacters: 100_000, render: "never" });
        assert.ok(d.text.length > 0, s.id);
        assert.equal(d.finalUrl, hit.url);
        assert.equal(d.security.decision, "allow");
      }
      if (s.id === "misleading-snippet") {
        assert.ok(hits[0]!.snippet.includes("20 GB"));
        assert.ok((await client.read({ url: hits[0]!.url })).text.includes("2 GB"));
      }
      if (s.id === "tail-specification") {
        const d = await client.read({ url: hits[0]!.url, maxCharacters: 100_000 });
        assert.ok(d.text.length > 20_000);
        assert.ok(d.text.includes("320 concurrent connections per workspace"));
      }
    } finally {
      await client.close();
    }
  }
});

await test("slow fixture respects per-read cancellation without cancelling other sources", async () => {
  const client = fixtureClient(
    "slow-leading-pair",
    new AbortController().signal,
    undefined,
    300_000,
  );
  const controller = new AbortController();
  try {
    const hit = (await client.search({ query: "specification", limit: 10 }))[0]!;
    const read = client.read({ url: hit.url, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(new Error("Controlled read stop")), 20);
    try {
      await assert.rejects(read);
    } finally {
      clearTimeout(timer);
    }
    const d = await client.read({ url: "https://evaluation.example/sora/specification" });
    assert.ok(d.text.includes("24リットル"));
  } finally {
    await client.close();
  }
});

await test("short meaningful HTML reproduces the current extraction limitation without changing the scenario's factual success criteria", async () => {
  const client = fixtureClient("short-html-fact", new AbortController().signal);
  try {
    await assert.rejects(client.read({ url: "https://evaluation.example/nilo/tag-spec" }), {
      code: "CONTENT_INSUFFICIENT",
      reasonCode: "INSUFFICIENT_TEXT",
    });
  } finally {
    await client.close();
  }
});
