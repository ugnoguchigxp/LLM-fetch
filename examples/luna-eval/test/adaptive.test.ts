import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createLlmFetch, LlmFetchError } from "../../../dist/index.js";
import type { SafeHttpFetcher, SearchProvider } from "../../../dist/index.js";
import type { z } from "zod";
import type { Model, ResearchPlan, ResearchDecision, ModelStage } from "../contracts.ts";
import { dimensions } from "../contracts.ts";
import { adaptivePolicy } from "../adaptive.ts";
import { runScenario } from "../pipeline.ts";
import { scenarios } from "../scenarios.ts";
import { fixtureSets } from "../fixtures.ts";
import { summarize } from "../report.ts";

const signal = new AbortController().signal;
const scenario = scenarios.find((s) => s.id === "table-units")!;
const plan: ResearchPlan = {
  rationale: "公式の料金を確認",
  requirements: ["料金と単位"],
  searches: [{ query: "Orion pricing", allowedHosts: [] }],
  initialConcurrency: 1,
};
const baseUrl = "https://evaluation.example";
const body =
  "# Orion\n\n| Plan | Monthly JPY | Storage GB | Days |\n|---|---:|---:|---:|\n| Basic | 900 | 10 | 7 |\n| Pro | 2400 | 80 | 30 |\n\nMonthly tax-inclusive pricing. The storage and retention limits apply to each plan.";
const hit = (n: number) => ({
  url: `${baseUrl}/${n}`,
  title: `Orion ${n}`,
  snippet: "Monthly prices",
  rank: n,
  provider: "controlled",
});
function client(
  search: SearchProvider["search"] = async () => [hit(1), hit(2), hit(3)],
  fetcher?: SafeHttpFetcher,
) {
  return createLlmFetch({
    search: { name: "controlled", search },
    cache: { enabled: false },
    fetcher:
      fetcher ??
      (async (url) => ({
        requestedUrl: url,
        finalUrl: url,
        status: 200,
        contentType: "text/markdown",
        headers: { "content-type": "text/markdown" },
        body: new TextEncoder().encode(body),
      })),
  });
}
type ResearchInput = { evidence: { documents: { url: string }[] } };
function respond(data: ResearchInput, changes: Partial<ResearchDecision> = {}): ResearchDecision {
  const urls = data.evidence.documents.map((d: { url: string }) => d.url);
  return {
    action: "answer",
    reason: "本文で確認",
    query: null,
    urls: [],
    coverage: [
      { requirement: 1, status: urls.length ? "supported" : "missing", urls: urls.slice(0, 1) },
    ],
    answer: {
      answer:
        "|プラン|月額円|容量GB|保持日数|\n|---|---:|---:|---:|\n|Basic|900|10|7|\n|Pro|2400|80|30|",
      insufficientEvidence: !urls.length,
      citations: urls.slice(0, 1).map((url: string) => ({ url, claim: "料金比較" })),
    },
    ...changes,
  };
}
function model(
  researchPlan = plan,
  decide: (d: ResearchInput, turn: number) => ResearchDecision | Promise<ResearchDecision> = (d) =>
    respond(d),
): Model {
  let turn = 0;
  return {
    async generate<T>(stage: ModelStage, prompt: string, schema: z.ZodType<T>) {
      const data = JSON.parse(prompt.split("入力データ(JSON):\n")[1]!);
      if (stage !== "judge") {
        assert.ok(!prompt.includes('"expectedEvidence"'));
        for (const c of scenario.criteria) assert.ok(!prompt.includes(c.description));
      }
      return schema.parse(
        stage === "query"
          ? researchPlan
          : stage === "answer"
            ? await decide(data, turn++)
            : stage === "guard"
              ? { decision: "source_content" }
              : {
                  ...Object.fromEntries(
                    dimensions.map((d) => [d, { score: 4, reason: "controlled contract test" }]),
                  ),
                  criteria: scenario.criteria.map((c) => ({
                    id: c.id,
                    result: "pass",
                    reason: "controlled",
                  })),
                },
      );
    },
  };
}
const settings = {
  provider: "brave" as const,
  strategy: "adaptive" as const,
  scenarioTimeoutMs: 5000,
  adaptivePolicy: {
    ...adaptivePolicy,
    targetMs: 1000,
    answerReserveMs: 100,
    minimumRetrievalWindowMs: 1000,
  },
};
const run = (m: Model, c: ReturnType<typeof client>, policy = settings.adaptivePolicy) =>
  runScenario(scenario, 1, m, { ...settings, adaptivePolicy: policy }, signal, () => c);

await test("adaptive default reads one source and uses two research model turns", async () => {
  const r = await run(model(), client());
  assert.equal(r.status, "passed");
  assert.equal(summarize([r]).retrieval.reads, 1);
  assert.equal(r.research!.decisions.length, 1);
  assert.equal(r.research!.stopReason, "sufficient");
  const input = r.research!.evidenceUsed!;
  assert.ok(!JSON.stringify(input).includes("segmentHash"));
  assert.ok(!JSON.stringify(input).includes("diagnostics"));
});

await test("first sufficient source cancels slow parallel read rather than awaiting all", async () => {
  let aborted = false;
  const c = client(undefined, async (url, input) => {
    if (url.endsWith("/2"))
      try {
        await delay(4000, undefined, { signal: input?.signal });
      } catch (e) {
        aborted = true;
        throw e;
      }
    return {
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      contentType: "text/markdown",
      headers: {},
      body: new TextEncoder().encode(body),
    };
  });
  const r = await run(model({ ...plan, initialConcurrency: 2 }), c);
  assert.equal(r.status, "passed");
  assert.equal(aborted, true);
  assert.ok(r.pipelineMs < 500);
  assert.equal(r.trace.filter((t) => t.cancellation === "sufficient").length, 1);
  assert.equal(summarize([r]).retrieval.readFailures, 0);
});

await test("a slow second search cannot block first completed evidence", async () => {
  let cancelled = false;
  const c = client(async (input) => {
    if (input.query === "slow")
      try {
        await delay(4000, undefined, { signal: input.signal });
      } catch (e) {
        cancelled = true;
        throw e;
      }
    return [hit(1)];
  });
  const r = await run(
    model({
      ...plan,
      searches: [...plan.searches, { query: "slow", allowedHosts: [] }],
      initialConcurrency: 2,
    }),
    c,
  );
  assert.equal(r.status, "passed");
  assert.ok(r.pipelineMs < 500);
  assert.equal(cancelled, true);
});

await test("missing independent evidence waits for pending source then answers", async () => {
  const c = client(undefined, async (url, input) => {
    if (url.endsWith("/2")) await delay(30, undefined, { signal: input?.signal });
    return {
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      contentType: "text/markdown",
      headers: {},
      body: new TextEncoder().encode(body),
    };
  });
  const r = await run(
    model({ ...plan, initialConcurrency: 2 }, (d) =>
      d.evidence.documents.length === 1
        ? respond(d, { action: "wait", answer: null, reason: "別資料が必要" })
        : respond(d),
    ),
    c,
  );
  assert.equal(r.status, "passed");
  assert.deepEqual(
    r.research!.decisions.map((d) => d.action),
    ["wait", "answer"],
  );
});

await test("incomplete first source requests only the next selected candidate", async () => {
  const r = await run(
    model(plan, (d, n) =>
      n === 0 ? respond(d, { action: "read", answer: null, urls: [hit(2).url] }) : respond(d),
    ),
    client(),
  );
  assert.equal(r.status, "passed");
  assert.equal(summarize([r]).retrieval.reads, 2);
});

await test("search failure can be recovered with a different query and selected read", async () => {
  const c = client(async (input) => {
    if (input.query === plan.searches[0]!.query)
      throw new LlmFetchError("TIMEOUT", "Controlled failure", { retryable: true });
    return [hit(1)];
  });
  const r = await run(
    model(plan, (d, n) =>
      n === 0
        ? respond(d, { action: "search", query: "Orion official alternate", answer: null })
        : n === 1
          ? respond(d, { action: "read", urls: [hit(1).url], answer: null })
          : respond(d),
    ),
    c,
  );
  assert.equal(r.status, "passed");
  assert.equal(summarize([r]).retrieval.reads, 1);
  assert.equal(r.research!.decisions.length, 3);
});

await test("host source constraint is enforced and never bypasses the guard", async () => {
  const r = await run(
    model({ ...plan, searches: [{ query: "official", allowedHosts: ["official.example"] }] }),
    client(),
  );
  assert.equal(summarize([r]).retrieval.reads, 0);
  assert.equal(r.answer!.insufficientEvidence, true);
});

await test("retrieval budget aborts pending work and records a deadline, not sufficient cancellation", async () => {
  const c = client(undefined, async (url, input) => {
    if (url.endsWith("/2")) await delay(4000, undefined, { signal: input?.signal });
    return {
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      contentType: "text/markdown",
      headers: {},
      body: new TextEncoder().encode(body),
    };
  });
  const r = await run(
    model({ ...plan, initialConcurrency: 2 }, async (d) => {
      await delay(50);
      return respond(d);
    }),
    c,
    { ...settings.adaptivePolicy, targetMs: 10, answerReserveMs: 5, minimumRetrievalWindowMs: 20 },
  );
  assert.equal(r.status, "passed");
  assert.equal(r.trace.filter((t) => t.cancellation === "deadline").length, 1);
});

await test("a source completed during answer generation cannot authorize an unseen citation", async () => {
  const c = client(undefined, async (url, input) => {
    if (url.endsWith("/2")) await delay(20, undefined, { signal: input?.signal });
    return {
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      contentType: "text/markdown",
      headers: {},
      body: new TextEncoder().encode(body),
    };
  });
  const r = await run(
    model({ ...plan, initialConcurrency: 2 }, async (d) => {
      await delay(40);
      const answer = respond(d).answer!;
      answer.citations = [{ url: hit(2).url, claim: "unseen" }];
      return respond(d, { answer });
    }),
    c,
  );
  assert.equal(r.status, "failed");
  assert.ok(r.contractFailures.some((f) => f.includes("absent from answer input")));
});

await test("unseen URLs, repeated URLs and invalid coverage fail closed", async () => {
  for (const decision of [
    (d: ResearchInput) =>
      respond(d, { action: "read", answer: null, urls: ["https://outside.example/"] }),
    (d: ResearchInput) => respond(d, { action: "read", answer: null, urls: [hit(1).url] }),
    (d: ResearchInput) => respond(d, { coverage: [] }),
  ]) {
    const r = await run(model(plan, decision), client());
    assert.equal(r.status, "error");
  }
});

await test("all read launches honor the three-source ceiling", async () => {
  const r = await run(
    model({ ...plan, initialConcurrency: 2 }, (d, n) =>
      n === 0 ? respond(d, { action: "read", answer: null, urls: [hit(3).url] }) : respond(d),
    ),
    client(),
  );
  assert.equal(r.status, "passed");
  assert.ok(summarize([r]).retrieval.reads <= 3);
});

await test("adaptive retrieval keeps rejected content out of the answering context", async () => {
  const base = model({ ...plan, initialConcurrency: 2 }, (d) =>
    d.evidence.documents.length ? respond(d) : respond(d, { action: "wait", answer: null }),
  );
  const guarded: Model = {
    async generate(stage, prompt, schema, signal, measurements) {
      if (stage === "guard") {
        const input = JSON.parse(prompt.split("入力データ(JSON):\n")[1]!);
        assert.equal(input.request, scenario.request);
        return schema.parse({ decision: "injection" });
      }
      assert.ok(stage !== "answer" || !prompt.includes("Answer 9999"));
      return base.generate(stage, prompt, schema, signal, measurements);
    },
  };
  const r = await runScenario(
    scenario,
    1,
    guarded,
    settings,
    signal,
    (_s, _settings, _signal, review) =>
      createLlmFetch({
        search: { name: "controlled", search: async () => [hit(1), hit(2)] },
        cache: { enabled: false },
        contextGuard: { review: review! },
        fetcher: async (url) => ({
          requestedUrl: url,
          finalUrl: url,
          status: 200,
          contentType: "text/html",
          headers: {},
          body: new TextEncoder().encode(
            url.endsWith("/1")
              ? fixtureSets.injection![1]!.body
              : "<html><body><main>The Basic plan costs 900 JPY each month and includes 10 GB of storage and seven days of retention. The Pro plan costs 2400 JPY per month with 80 GB and thirty days.</main></body></html>",
          ),
        }),
      }),
  );
  assert.equal(r.status, "passed", JSON.stringify({ error: r.error, trace: r.trace }));
  assert.ok(r.trace.some((t) => t.error?.code === "GUARD_DENIED"));
  assert.ok(!JSON.stringify(r.research!.evidenceUsed).includes("9999"));
});

await test("cancelled semantic assessment is drained before metrics are persisted", async () => {
  const base = model();
  let finished = false;
  const slow: Model = {
    async generate(stage, prompt, schema, signal, measurements) {
      if (stage === "guard") {
        await delay(40);
        measurements.push({
          stage: "guard",
          model: "controlled",
          durationMs: 40,
          firstEventMs: null,
          firstMessageEventMs: null,
          threadId: null,
          error: "cancelled",
          usage: null,
        });
        finished = true;
        return schema.parse({ decision: "source_content" });
      }
      return base.generate(stage, prompt, schema, signal, measurements);
    },
  };
  const r = await runScenario(
    scenario,
    1,
    slow,
    {
      ...settings,
      adaptivePolicy: {
        ...settings.adaptivePolicy,
        targetMs: 1,
        answerReserveMs: 1,
        minimumRetrievalWindowMs: 10,
      },
    },
    signal,
    (_s, _settings, _signal, review) =>
      createLlmFetch({
        search: { name: "controlled", search: async () => [hit(1)] },
        cache: { enabled: false },
        contextGuard: { review: review! },
        fetcher: async (url) => ({
          requestedUrl: url,
          finalUrl: url,
          status: 200,
          contentType: "text/html",
          headers: {},
          body: new TextEncoder().encode(fixtureSets.injection![1]!.body),
        }),
      }),
  );
  assert.equal(finished, true, JSON.stringify({ error: r.error, trace: r.trace }));
  const persisted = JSON.stringify(r);
  await delay(45);
  assert.equal(JSON.stringify(r), persisted);
  assert.equal(summarize([r]).tokens.all.missingUsageCalls, 1);
});

await test("truncated source can be expanded from inspected retained text without another fetch", async () => {
  let fetches = 0;
  const c = client(undefined, async (url) => {
    fetches++;
    return {
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      contentType: "text/markdown",
      headers: {},
      body: new TextEncoder().encode(
        body + "\n\n" + "Additional specification details for the plans. ".repeat(50),
      ),
    };
  });
  const r = await run(
    model(plan, (d, n) =>
      n === 0 ? respond(d, { action: "read", answer: null, urls: [hit(1).url] }) : respond(d),
    ),
    c,
    { ...settings.adaptivePolicy, documentCharacters: 200 },
  );
  assert.equal(r.status, "passed");
  assert.equal(fetches, 1);
  assert.equal(summarize([r]).retrieval.reads, 1);
  assert.equal(summarize([r]).retrieval.successfulReads, 1);
  assert.equal(summarize([r]).retrieval.expandedViews, 1);
  assert.equal(r.research!.evidenceUsed!.documents[0]!.text.length, 400);
});

await test("duplicate search is blocked and returned to Luna for a bounded final answer", async () => {
  const r = await run(
    model(plan, (d, n) =>
      n === 0
        ? respond(d, { action: "search", answer: null, query: plan.searches[0]!.query })
        : respond(d, {
            answer: {
              answer: "公開資料を確認できませんでした。",
              citations: [],
              insufficientEvidence: true,
            },
          }),
    ),
    client(async () => []),
  );
  assert.equal(r.status, "passed");
  assert.equal(summarize([r]).retrieval.searches, 1);
  assert.equal(r.research!.actionErrors.length, 1);
  assert.equal(r.research!.decisions.length, 2);
});
