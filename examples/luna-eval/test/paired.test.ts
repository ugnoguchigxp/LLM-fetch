import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createLlmFetch } from "../../../dist/index.js";
import type { SafeHttpFetcher, SearchProvider } from "../../../dist/index.js";
import { decisionAnswer, pairedPolicy, validateDecision } from "../paired.ts";
import { goalJudgeSchema, pairedDecisionSchema, dimensions } from "../contracts.ts";
import type { Model, PairedDecision, PairedPlan } from "../contracts.ts";
import type { answerEvidence } from "../pipeline.ts";
import { judgeStatus, runScenario } from "../pipeline.ts";
import { scenarios } from "../scenarios.ts";
import { summarize } from "../report.ts";
import { fixtureSets } from "../fixtures.ts";

const scenario = scenarios.find((s) => s.id === "table-units")!;
const plan: PairedPlan = {
  rationale: "料金表を確認",
  requirements: ["料金と単位"],
  searches: [{ query: "Orion pricing", allowedHosts: [] }],
};
const body =
  "# Orion\n\nBasic: 900 JPY / month, 10 GB, 7 days. Pro: 2400 JPY / month, 80 GB, 30 days.";
const hit = (n: number) => ({
  url: `https://evaluation.example/${n}`,
  title: `Pricing ${n}`,
  snippet: "Untrusted search description",
  rank: n,
  provider: "controlled",
});
type Input = { evidence: ReturnType<typeof answerEvidence>; canContinue: boolean };
function respond(input: Input, sufficient = true): PairedDecision {
  const d = input.evidence.documents[0];
  const evidence = d
    ? [{ url: d.url, quote: d.text.trim(), claim: "Basic 900円、Pro 2400円の月額料金" }]
    : [];
  return {
    sufficient: sufficient && !!d,
    reason: sufficient ? "本文で確認" : "必要情報が不足",
    coverage: [{ requirement: 1, status: sufficient && d ? "supported" : "missing", evidence }],
    answer:
      (sufficient && d) || !input.canContinue
        ? {
            answer: d
              ? "|プラン|月額円|容量GB|保持日数|\n|---|---:|---:|---:|\n|Basic|900|10|7|\n|Pro|2400|80|30|"
              : "取得した範囲で確認できません。不存在とは断定できません。",
            citationRefs: evidence.map((_, i) => ({ requirement: 1, evidence: i + 1 })),
            insufficientEvidence: !sufficient || !d,
          }
        : null,
  };
}
function model(
  decide: (d: Input, n: number) => PairedDecision | Promise<PairedDecision> = (d) => respond(d),
  researchPlan = plan,
): Model {
  let count = 0;
  return {
    async generate(stage, prompt, schema) {
      const data = JSON.parse(prompt.split("入力データ(JSON):\n")[1]!);
      if (stage !== "judge") {
        assert.ok(!prompt.includes('"expectedEvidence"'));
        for (const criterion of scenario.criteria)
          assert.ok(!prompt.includes(criterion.description));
      }
      if (stage === "query") return schema.parse(researchPlan);
      if (stage === "assess") return schema.parse(await decide(data, count++));
      if (stage === "guard") return schema.parse({ decision: "source_content" });
      assert.equal(stage, "judge");
      return schema.parse({
        ...Object.fromEntries(
          dimensions.map((d) => [
            d,
            { score: 4, reason: "Controlled contract test, not semantic quality measurement" },
          ]),
        ),
        criteria: scenario.criteria.map((c) => ({
          id: c.id,
          result: "pass",
          reason: "Controlled",
        })),
        goalSatisfied: true,
        goalReason: "Controlled",
      });
    },
  };
}
const document = (url: string, text = body) => ({
  requestedUrl: url,
  finalUrl: url,
  status: 200,
  contentType: "text/markdown",
  headers: {},
  body: new TextEncoder().encode(text),
});
function client(
  fetcher: SafeHttpFetcher = async (url) => document(url),
  search: SearchProvider["search"] = async () => [hit(1), hit(2), hit(3), hit(4), hit(5), hit(6)],
) {
  return createLlmFetch({
    search: { name: "controlled", search },
    fetcher,
    cache: { enabled: false },
  });
}
const settings = {
  provider: "brave" as const,
  strategy: "paired" as const,
  scenarioTimeoutMs: 5000,
  pairedPolicy: { ...pairedPolicy, hedgeAfterMs: 1000 },
};
const run = (
  m: Model,
  c: ReturnType<typeof client>,
  policy = settings.pairedPolicy,
  signal = new AbortController().signal,
) => runScenario(scenario, 1, m, { ...settings, pairedPolicy: policy }, signal, () => c);

await test("default hedge is ten seconds and first Markdown starts assessment before the second finishes", async () => {
  assert.equal(pairedPolicy.hedgeAfterMs, 10_000);
  let secondFinished = false;
  let secondCancelled = false;
  const c = client(async (url, input) => {
    if (url.endsWith("/2")) {
      try {
        await delay(1000, undefined, { signal: input?.signal });
        secondFinished = true;
      } catch (e) {
        secondCancelled = true;
        throw e;
      }
    }
    return document(url);
  });
  const r = await run(
    model((d) => {
      assert.equal(secondFinished, false);
      return respond(d);
    }),
    c,
  );
  assert.equal(r.status, "passed", r.error ?? "");
  assert.equal(r.paired!.batches[0]!.urls.length, 2);
  assert.equal(r.paired!.decisions.length, 1);
  assert.equal(r.paired!.decisions[0]!.evidenceUrls.length, 1);
  assert.equal(secondCancelled, true);
  assert.equal(r.paired!.stopReason, "sufficient");
  assert.ok(r.paired!.firstEvaluationMs! >= r.paired!.firstMarkdownMs!);
  assert.equal(summarize([r]).retrieval.readFailures, 0);
});

await test("hedge adds two while both earlier reads remain pending; it does not cancel or impose concurrency two", async () => {
  const waiting = new Set<string>();
  let earlierStillWaiting = false;
  const c = client(async (url, input) => {
    if (url.endsWith("/3")) {
      earlierStillWaiting = waiting.has(hit(1).url) && waiting.has(hit(2).url);
      return document(url);
    }
    waiting.add(url);
    try {
      await delay(1000, undefined, { signal: input?.signal });
      return document(url);
    } finally {
      waiting.delete(url);
    }
  });
  const r = await run(model(), c, { ...settings.pairedPolicy, hedgeAfterMs: 25 });
  assert.equal(r.status, "passed", r.error ?? "");
  assert.equal(earlierStillWaiting, true);
  assert.deepEqual(
    r.paired!.batches.map((b) => b.reason),
    ["initial", "hedge"],
  );
  assert.equal(r.paired!.peakActiveReads, 4);
  assert.equal(r.trace.filter((t) => t.cancellation === "sufficient").length, 3);
});

await test("insufficient assessment immediately adds another pair and retains earlier pending read", async () => {
  let pendingSecond = false;
  let thirdObservedPending = false;
  const c = client(async (url, input) => {
    if (url.endsWith("/3")) thirdObservedPending = pendingSecond;
    if (url.endsWith("/2") || url.endsWith("/4")) {
      if (url.endsWith("/2")) pendingSecond = true;
      try {
        await delay(1000, undefined, { signal: input?.signal });
      } finally {
        if (url.endsWith("/2")) pendingSecond = false;
      }
    }
    return document(url);
  });
  const r = await run(
    model((d, n) => respond(d, n > 0)),
    c,
  );
  assert.equal(r.status, "passed", r.error ?? "");
  assert.equal(thirdObservedPending, true);
  assert.deepEqual(
    r.paired!.batches.map((b) => b.reason),
    ["initial", "insufficient"],
  );
  assert.ok(r.paired!.batches[1]!.atMs - r.paired!.decisions[0]!.completedMs < 100);
  assert.equal(r.paired!.decisions.length, 2);
});

await test("new Markdown and hedge timers proceed during a single in-flight LLM assessment", async () => {
  let running = 0,
    maximum = 0;
  const c = client(async (url, input) => {
    if (!url.endsWith("/1"))
      await delay(url.endsWith("/2") ? 10 : 1000, undefined, { signal: input?.signal });
    return document(url);
  });
  const r = await run(
    model(async (d, n) => {
      running++;
      maximum = Math.max(maximum, running);
      try {
        if (n === 0) await delay(80);
        return respond(d, n > 0);
      } finally {
        running--;
      }
    }),
    c,
    { ...settings.pairedPolicy, hedgeAfterMs: 25 },
  );
  assert.equal(r.status, "passed", r.error ?? "");
  assert.equal(maximum, 1);
  assert.ok(
    r.paired!.batches.some(
      (b) => b.reason === "hedge" && b.atMs < r.paired!.decisions[0]!.completedMs,
    ),
  );
  assert.equal(r.paired!.decisions[0]!.evidenceUrls.length, 1);
  assert.equal(r.paired!.decisions[1]!.evidenceUrls.length, 2);
});

await test("a slow second search never holds the first Markdown behind a search barrier", async () => {
  let cancelled = false;
  const c = client(undefined, async (input) => {
    if (input.query === "slow") {
      try {
        await delay(1000, undefined, { signal: input.signal });
      } catch (e) {
        cancelled = true;
        throw e;
      }
    }
    return [hit(1), hit(2)];
  });
  const r = await run(
    model((d) => respond(d), {
      ...plan,
      searches: [...plan.searches, { query: "slow", allowedHosts: [] }],
    }),
    c,
  );
  assert.equal(r.status, "passed", r.error ?? "");
  assert.equal(cancelled, true);
});

await test("unchanged evidence is not reassessed until completion or exhaustion", async () => {
  const c = client(
    async (url, input) => {
      if (url.endsWith("/2")) await delay(40, undefined, { signal: input?.signal });
      return document(url);
    },
    async () => [hit(1), hit(2)],
  );
  const r = await run(
    model((d) => respond(d, false)),
    c,
  );
  assert.equal(r.status, "passed", r.error ?? "");
  assert.equal(r.paired!.decisions.length, 2);
  assert.deepEqual(
    r.paired!.decisions.map((d) => d.canContinue),
    [true, false],
  );
  assert.equal(r.answer!.insufficientEvidence, true);
  assert.equal(r.paired!.stopReason, "exhausted");
});

await test("empty and entirely failed retrieval yield honest terminal answers, never sufficient", async () => {
  for (const c of [
    client(undefined, async () => []),
    client(async () => {
      throw new Error("controlled network failure");
    }),
  ]) {
    const r = await run(
      model((d) => respond(d, false)),
      c,
    );
    assert.equal(r.status, "passed", r.error ?? "");
    assert.equal(r.answer!.insufficientEvidence, true);
    assert.equal(r.paired!.stopReason, "exhausted");
    assert.equal(r.paired!.decisions.length, 1);
    assert.equal(r.paired!.evidenceUsed!.documents.length, 0);
  }
});

await test("source constraints cannot silently authorize candidates from a different host", async () => {
  let fetches = 0;
  const r = await run(
    model((d) => respond(d, false), {
      ...plan,
      searches: [{ query: "official", allowedHosts: ["official.example"] }],
    }),
    client(async (url) => {
      fetches++;
      return document(url);
    }),
  );
  assert.equal(r.status, "passed", r.error ?? "");
  assert.equal(fetches, 0);
  assert.equal(r.answer!.insufficientEvidence, true);
});

await test("quotes, requirement coverage and claim bindings fail closed", () => {
  const input: Input = {
    evidence: {
      documents: [
        {
          url: hit(1).url,
          text: body,
          fetchedAt: new Date().toISOString(),
          truncated: false,
          security: {
            trust: "untrusted",
            tainted: true,
            decision: "allow",
            warningCategories: [],
            reasonCodes: [],
          },
        },
      ],
      failures: [],
    },
    canContinue: true,
  };
  validateDecision(respond(input), plan, input.evidence, true);
  assert.deepEqual(decisionAnswer(respond(input))!.citations, [
    { url: hit(1).url, claim: "Basic 900円、Pro 2400円の月額料金" },
  ]);
  for (const mutate of [
    (d: PairedDecision) => {
      d.coverage = [];
    },
    (d: PairedDecision) => {
      d.coverage[0]!.evidence = [];
    },
    (d: PairedDecision) => {
      d.coverage[0]!.evidence[0]!.quote = "fabricated price";
    },
    (d: PairedDecision) => {
      d.coverage[0]!.evidence[0]!.url = hit(99).url;
    },
    (d: PairedDecision) => {
      d.coverage[0]!.status = "missing";
    },
    (d: PairedDecision) => {
      d.answer!.citationRefs[0]!.evidence = 4;
    },
    (d: PairedDecision) => {
      d.answer!.insufficientEvidence = true;
    },
  ]) {
    const d = respond(input);
    mutate(d);
    assert.throws(() => validateDecision(d, plan, input.evidence, true));
  }
  const d = respond(input);
  d.coverage[0]!.evidence[0]!.quote = "   ";
  assert.equal(pairedDecisionSchema.safeParse(d).success, false);
});

await test("a late completed source cannot authorize an unseen quote or citation", async () => {
  const c = client(async (url, input) => {
    if (url.endsWith("/2")) await delay(10, undefined, { signal: input?.signal });
    return document(url);
  });
  const r = await run(
    model(async (d) => {
      await delay(30);
      const response = respond(d);
      response.coverage[0]!.evidence[0]!.url = hit(2).url;
      return response;
    }),
    c,
  );
  assert.equal(r.status, "error");
  assert.match(r.error!, /quote absent from answer input/);
});

await test("caller cancellation drains pending retrieval and persists stable metrics", async () => {
  let finished = 0;
  const c = client(async (url, input) => {
    try {
      await delay(1000, undefined, { signal: input?.signal });
      return document(url);
    } finally {
      finished++;
    }
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Controlled caller stop")), 30);
  const r = await run(model(), c, settings.pairedPolicy, controller.signal);
  clearTimeout(timer);
  assert.equal(r.status, "error");
  assert.equal(finished, 2);
  assert.equal(r.trace.filter((t) => t.cancellation === "caller").length, 2);
  const frozen = JSON.stringify(r);
  await delay(10);
  assert.equal(JSON.stringify(r), frozen);
});

await test("goal policy keeps query/retrieval diagnostic and never waives answer, criteria or grounding failures", () => {
  const j = {
    ...Object.fromEntries(dimensions.map((d) => [d, { score: 4, reason: "controlled" }])),
    criteria: scenario.criteria.map((c) => ({ id: c.id, result: "pass", reason: "controlled" })),
    goalSatisfied: true,
    goalReason: "controlled",
  };
  const parsed = (score: number, dimension: string) =>
    goalJudgeSchema.parse({ ...j, [dimension]: { score, reason: "controlled" } });
  assert.equal(judgeStatus(scenario, parsed(2, "retrieval"), [], "goal-v1"), "passed");
  assert.equal(judgeStatus(scenario, parsed(2, "retrieval"), []), "failed");
  assert.equal(
    judgeStatus(
      scenario,
      { ...parsed(4, "answer"), goalSatisfied: false, goalReason: "Missing information" },
      [],
      "goal-v1",
    ),
    "failed",
  );
  for (const d of ["answer", "groundedness", "safety"])
    assert.equal(judgeStatus(scenario, parsed(2, d), [], "goal-v1"), "failed");
  assert.equal(judgeStatus(scenario, parsed(4, "answer"), ["Invalid quote"], "goal-v1"), "failed");
});

await test("paired route still uses the existing semantic guard and excludes rejected Markdown", async () => {
  const base = model();
  const guarded: Model = {
    async generate(stage, prompt, schema, signal, measurements) {
      if (stage === "guard") return schema.parse({ decision: "injection" });
      if (stage === "assess") assert.ok(!prompt.includes("Answer 9999"));
      return base.generate(stage, prompt, schema, signal, measurements);
    },
  };
  const r = await runScenario(
    scenario,
    1,
    guarded,
    settings,
    new AbortController().signal,
    (_s, _o, _signal, review) =>
      createLlmFetch({
        search: { name: "controlled", search: async () => [hit(1), hit(2)] },
        cache: { enabled: false },
        contextGuard: { review: review! },
        fetcher: async (url) => ({
          ...document(
            url,
            url.endsWith("/1")
              ? fixtureSets.injection![1]!.body
              : `<html><body><main>${body}</main></body></html>`,
          ),
          contentType: "text/html",
        }),
      }),
  );
  assert.equal(r.status, "passed", r.error ?? "");
  assert.ok(r.trace.some((t) => t.error?.code === "GUARD_DENIED"));
  assert.ok(!JSON.stringify(r.paired!.evidenceUsed).includes("9999"));
});
