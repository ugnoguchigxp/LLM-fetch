import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import type { ThreadEvent } from "@openai/codex-sdk";
import { answerSchema, dimensions, querySchema, selectionSchema } from "../contracts.ts";
import type { Answer, Judgment, Measurement, Model, ModelStage, Scenario } from "../contracts.ts";
import { fixtureClient, fixtureSets } from "../fixtures.ts";
import { outputSchema, sdkEnvironment, sdkModel } from "../model.ts";
import { runScenario } from "../pipeline.ts";
import { distribution, summarize, tokenSummary, writeReport } from "../report.ts";
import { scenarios, validateScenarios } from "../scenarios.ts";

const signal = new AbortController().signal;
const settings = { provider: "brave" as const, scenarioTimeoutMs: 10_000 };
const caseById = (id: string) => scenarios.find((s) => s.id === id)!;
function verdict(s: Scenario): Judgment {
  return {
    ...Object.fromEntries(dimensions.map((d) => [d, { score: 4, reason: "fixture assertion" }])),
    criteria: s.criteria.map((c) => ({ id: c.id, result: "pass" as const, reason: "verified" })),
  } as Judgment;
}
const tableAnswer: Answer = {
  answer: "Basicは900円・10 GB・7日。Proは2400円・80 GB・30日。",
  insufficientEvidence: false,
  citations: [{ url: "https://evaluation.example/orion/pricing", claim: "月額比較" }],
};
function fakeModel(s: Scenario, overrides: Partial<Record<ModelStage, unknown>> = {}): Model {
  return {
    async generate<T>(stage: ModelStage, prompt: string, schema: z.ZodType<T>) {
      if (stage !== "judge") {
        for (const criterion of s.criteria)
          assert.ok(!prompt.includes(criterion.description), "rubric leaked");
        assert.ok(!prompt.includes('"expectedEvidence"'), "expected outcome leaked");
      }
      const defaults: Record<ModelStage, unknown> = {
        assess: new Error("Paired assessment is not used by legacy tests"),
        guard: { decision: "source_content" },
        query: { queries: ["Orion Basic Pro 月額"], rationale: "比較対象と項目" },
        selection: { urls: ["https://evaluation.example/orion/pricing"], rationale: "料金表" },
        answer: tableAnswer,
        judge: verdict(s),
      };
      if (overrides[stage] instanceof Error) throw overrides[stage];
      return schema.parse(overrides[stage] ?? defaults[stage]);
    },
  };
}

await test("20 unique scenarios, with distinct live and controlled lanes", () => {
  const all = validateScenarios(scenarios);
  assert.equal(all.length, 20);
  assert.equal(all.filter((s) => s.mode === "live").length, 14);
  assert.equal(all.filter((s) => s.mode === "fixture").length, 6);
  for (const s of all.filter((s) => s.fixture)) assert.ok(fixtureSets[s.fixture!]);
  assert.throws(() => validateScenarios([...all, all[0]]));
  assert.throws(() => validateScenarios([{ ...all[0], mode: "fixture" }]));
});

await test("Responses transport schemas omit unsupported URI format while local URL validation remains strict", () => {
  for (const schema of [selectionSchema, answerSchema]) {
    assert.ok(!JSON.stringify(outputSchema(schema)).includes('"format":"uri"'));
  }
  assert.throws(() => selectionSchema.parse({ urls: ["not-a-url"], rationale: "" }));
});

await test("SDK child cannot inherit app control pipes, thread identity, or unrelated credentials", () => {
  const env = sdkEnvironment({
    PATH: "/bin",
    HOME: "/home/test",
    CODEX_APP_TOOLS_PIPE_PATH: "/socket",
    CODEX_THREAD_ID: "parent",
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Desktop",
    GH_TOKEN: "private",
    CODEX_API_KEY: "configured-key",
    HTTPS_PROXY: "https://proxy",
  });
  assert.deepEqual(env, {
    PATH: "/bin",
    HOME: "/home/test",
    CODEX_API_KEY: "configured-key",
    HTTPS_PROXY: "https://proxy",
  });
});

await test("real llm-fetch extraction and tool contracts run through the complete harness", async () => {
  const s = caseById("table-units");
  const r = await runScenario(s, 1, fakeModel(s), settings, signal);
  assert.equal(r.status, "passed");
  assert.equal(r.trace.length, 2);
  const fetch = r.trace[1]!.result;
  assert.equal(fetch?.type, "fetch_content_result");
  if (fetch?.type === "fetch_content_result") {
    assert.ok(fetch.document.text.includes("| Basic | 900 | 10 | 7 |"));
    assert.equal(fetch.security.tainted, true);
  }
  assert.ok(r.totalMs >= r.pipelineMs);
});

await test("searchAndRead strategy preserves grounding and removes a model round trip", async () => {
  const s = caseById("table-units");
  const base = fakeModel(s, { selection: new Error("unnecessary model round trip") });
  const calls: ModelStage[] = [];
  const model: Model = {
    async generate<T>(
      stage: ModelStage,
      prompt: string,
      schema: z.ZodType<T>,
      signal: AbortSignal,
      measurements: Measurement[],
    ) {
      calls.push(stage);
      return base.generate(stage, prompt, schema, signal, measurements);
    },
  };
  const r = await runScenario(s, 1, model, { ...settings, strategy: "search-and-read" }, signal);
  assert.equal(r.status, "passed");
  assert.deepEqual(calls, ["query", "answer", "judge"]);
  assert.equal(r.trace[0]!.result?.type, "search_and_read_result");
  assert.equal(summarize([r]).retrieval.reads, 1);
});

await test("combined retrieval preserves partial failures and rejects invented citations", async () => {
  const s = caseById("partial-failure");
  const r = await runScenario(
    s,
    1,
    fakeModel(s, {
      answer: {
        answer: "保証は2年、対応時間は確認できません。",
        insufficientEvidence: true,
        citations: [{ url: "https://evaluation.example/meridian/warranty", claim: "保証2年" }],
      },
    }),
    { ...settings, strategy: "search-and-read" },
    signal,
  );
  assert.equal(r.status, "passed");
  const summary = summarize([r]);
  assert.equal(summary.retrieval.reads, 2);
  assert.equal(summary.retrieval.readFailures, 1);
  assert.equal(summary.retrieval.errorCodes.UPSTREAM_HTTP, 1);
  const t = caseById("table-units");
  const bad = await runScenario(
    t,
    1,
    fakeModel(t, {
      answer: {
        ...tableAnswer,
        citations: [{ url: "https://invented.example/", claim: "wrong source" }],
      },
    }),
    { ...settings, strategy: "search-and-read" },
    signal,
  );
  assert.equal(bad.status, "failed");
});

await test("a fabricated citation fails even if an LLM judge assigns all fours", async () => {
  const s = caseById("table-units");
  const r = await runScenario(
    s,
    1,
    fakeModel(s, {
      answer: {
        ...tableAnswer,
        citations: [{ url: "https://invented.example/source", claim: "価格" }],
      },
    }),
    settings,
    signal,
  );
  assert.equal(r.status, "failed");
  assert.match(r.contractFailures.join(), /Citation absent/);
});

await test("a selected URL outside search results is never fetched", async () => {
  const s = caseById("table-units");
  const r = await runScenario(
    s,
    1,
    fakeModel(s, { selection: { urls: ["https://invented.example/"], rationale: "" } }),
    settings,
    signal,
  );
  assert.equal(r.status, "failed");
  assert.ok(!r.trace.some((t) => t.name === "fetch_content"));
});

await test("missing citations and sufficient-evidence claim with no documents are rejected", async () => {
  const s = caseById("empty-search");
  const r = await runScenario(
    s,
    1,
    fakeModel(s, {
      selection: { urls: [], rationale: "no results" },
      answer: { answer: "架空の答え", citations: [], insufficientEvidence: false },
    }),
    settings,
    signal,
  );
  assert.equal(r.status, "failed");
  assert.equal(r.contractFailures.length, 2);
});

await test("no-result abstention can pass, without pretending retrieval succeeded", async () => {
  const s = caseById("empty-search");
  const r = await runScenario(
    s,
    1,
    fakeModel(s, {
      selection: { urls: [], rationale: "0件" },
      answer: { answer: "確認できませんでした", citations: [], insufficientEvidence: true },
    }),
    settings,
    signal,
  );
  assert.equal(r.status, "passed");
  assert.equal(r.trace.length, 1);
  assert.equal(r.trace[0]!.result?.type, "web_search_result");
});

await test("judge outage is inconclusive and preserves the generated answer", async () => {
  const s = caseById("table-units");
  const r = await runScenario(
    s,
    1,
    fakeModel(s, { judge: new Error("judge unavailable") }),
    settings,
    signal,
  );
  assert.equal(r.status, "inconclusive");
  assert.equal(r.failedStage, "judge");
  assert.deepEqual(r.answer, tableAnswer);
});

await test("unknown criteria and missing/duplicate criteria cannot become a pass", async () => {
  const s = caseById("table-units");
  for (const criteria of [
    [],
    [verdict(s).criteria[0]!, verdict(s).criteria[0]!, verdict(s).criteria[2]!],
  ]) {
    const r = await runScenario(
      s,
      1,
      fakeModel(s, { judge: { ...verdict(s), criteria } }),
      settings,
      signal,
    );
    assert.equal(r.status, "inconclusive");
  }
  const v = verdict(s);
  v.criteria[0]!.result = "unknown";
  assert.equal(
    (await runScenario(s, 1, fakeModel(s, { judge: v }), settings, signal)).status,
    "inconclusive",
  );
});

await test("semantic quality failures are retained instead of weakened into passes", async () => {
  const s = caseById("table-units");
  const v = verdict(s);
  v.groundedness.score = 2;
  assert.equal(
    (await runScenario(s, 1, fakeModel(s, { judge: v }), settings, signal)).status,
    "failed",
  );
});

await test("fixture injection in visible and hidden content is blocked by real guard", async () => {
  const client = fixtureClient("injection", signal);
  try {
    const clean = await client
      .toolset()
      .execute("fetch_content", { url: "https://evaluation.example/lumen/spec" });
    assert.equal(clean.type, "fetch_content_result");
    for (const path of ["mirror", "hidden"]) {
      await assert.rejects(
        client.toolset().execute("fetch_content", {
          url: `https://evaluation.example/lumen/${path}`,
        }),
        { code: "GUARD_DENIED" },
      );
    }
    await assert.rejects(client.read({ url: "https://outside.example/" }), { code: "UNSAFE_URL" });
  } finally {
    await client.close();
  }
});

await test("partial retrieval failure preserves safe public error metadata and usable evidence", async () => {
  const s = caseById("partial-failure");
  const r = await runScenario(
    s,
    1,
    fakeModel(s, {
      selection: {
        urls: [
          "https://evaluation.example/meridian/warranty",
          "https://evaluation.example/meridian/support",
        ],
        rationale: "2項目",
      },
      answer: {
        answer: "保証2年。海外サポートの時間は不明。",
        insufficientEvidence: true,
        citations: [{ url: "https://evaluation.example/meridian/warranty", claim: "保証2年" }],
      },
    }),
    settings,
    signal,
  );
  assert.equal(r.status, "passed");
  assert.equal(r.trace.filter((t) => t.error).length, 1);
  assert.equal(r.trace[2]!.error?.code, "UPSTREAM_HTTP");
});

await test("caller cancellation yields an error, not an empty successful result", async () => {
  const s = caseById("table-units");
  const r = await runScenario(s, 1, fakeModel(s), settings, AbortSignal.abort());
  assert.equal(r.status, "error");
  assert.equal(r.judgment, null);
});

const usage = {
  input_tokens: 100,
  cached_input_tokens: 40,
  cache_write_input_tokens: 5,
  output_tokens: 20,
  reasoning_output_tokens: 8,
};
function source(events: ThreadEvent[]) {
  return {
    startThread() {
      return {
        async runStreamed() {
          return {
            events: (async function* () {
              for (const event of events) yield event;
            })(),
          };
        },
      };
    },
  };
}
const message: ThreadEvent = {
  type: "item.completed",
  item: {
    id: "m",
    type: "agent_message",
    text: JSON.stringify({ queries: ["abc"], rationale: "intent" }),
  },
};

await test("a successful SDK completion is not invalidated by a recovered transport error", async () => {
  const m: Measurement[] = [];
  const model = sdkModel(
    source([
      { type: "error", message: "Reconnecting..." },
      message,
      { type: "turn.completed", usage },
    ]),
    "/tmp",
    "luna",
    "judge",
    1000,
  );
  const result = await model.generate("query", "test", querySchema, signal, m);
  assert.deepEqual(result.queries, ["abc"]);
  assert.equal(m[0]!.error, null);
  assert.ok(m[0]!.sdkDiagnostics!.includes("Reconnecting..."));
});
await test("SDK event adapter records usage, timings and thread id", async () => {
  const measurements: Measurement[] = [];
  const model = sdkModel(
    source([
      { type: "thread.started", thread_id: "isolated" },
      message,
      { type: "turn.completed", usage },
    ]),
    "/tmp",
    "gpt-6-luna",
    "gpt-6-luna",
    1000,
  );
  await model.generate("query", "test", querySchema, signal, measurements);
  assert.equal(measurements[0]!.usage!.inputTokens, 100);
  assert.equal(measurements[0]!.usage!.cachedInputTokens, 40);
  assert.equal(measurements[0]!.threadId, "isolated");
  assert.ok(measurements[0]!.firstMessageEventMs !== null);
});

await test("legacy research reuses its thread while paired assessments, guard, judge, and next scenario stay isolated", async () => {
  let threads = 0;
  const starts: number[] = [];
  const model = sdkModel(
    {
      startThread() {
        const id = ++threads;
        return {
          id: String(id),
          async runStreamed() {
            starts.push(id);
            return {
              events: (async function* (): AsyncGenerator<ThreadEvent> {
                yield message;
                yield { type: "turn.completed", usage };
              })(),
            };
          },
        };
      },
    },
    "/tmp",
    "luna",
    "judge",
    1000,
  );
  const m: Measurement[] = [];
  for (const stage of ["query", "answer", "assess", "assess", "guard", "judge", "query"] as const) {
    await model.generate(stage, "test", querySchema, signal, m);
  }
  assert.deepEqual(starts, [1, 1, 2, 3, 4, 5, 6]);
});

await test("SDK missing completion, malformed JSON and unapproved tools fail closed", async () => {
  const cases: ThreadEvent[][] = [
    [message],
    [
      { ...message, item: { id: "m", type: "agent_message", text: "invalid JSON" } },
      { type: "turn.completed", usage },
    ],
    [
      { type: "item.started", item: { id: "t", type: "web_search", query: "bypass" } },
      message,
      { type: "turn.completed", usage },
    ],
    [{ type: "turn.failed", error: { message: "no model access" } }],
  ];
  for (const events of cases) {
    const m: Measurement[] = [];
    await assert.rejects(
      sdkModel(source(events), "/tmp", "luna", "judge", 1000).generate(
        "query",
        "test",
        querySchema,
        signal,
        m,
      ),
    );
    assert.ok(m[0]!.error);
    assert.equal(m[0]!.model, "luna");
  }
});

await test("a streamed model failure survives a subsequent generic SDK process exception", async () => {
  const model = sdkModel(
    {
      startThread() {
        return {
          async runStreamed() {
            return {
              events: (async function* (): AsyncGenerator<ThreadEvent> {
                yield { type: "turn.failed", error: { message: "specific upstream failure" } };
                throw new Error("Codex Exec exited with code 1");
              })(),
            };
          },
        };
      },
    },
    "/tmp",
    "luna",
    "judge",
    1000,
  );
  const m: Measurement[] = [];
  await assert.rejects(
    model.generate("query", "test", querySchema, signal, m),
    /specific upstream failure/,
  );
  assert.deepEqual(m[0]!.sdkEvents, ["turn.failed"]);
  assert.equal(m[0]!.usage, null);
});

await test("early infrastructure failures cannot make completed-answer latency appear faster", async () => {
  const s = caseById("table-units");
  const good = await runScenario(s, 1, fakeModel(s), settings, signal);
  good.pipelineMs = 2000;
  const earlyFailure = { ...good, answer: null, status: "error" as const, pipelineMs: 5 };
  const summary = summarize([good, earlyFailure]);
  assert.equal(summary.pipelineMs.n, 1);
  assert.equal(summary.pipelineMs.p50, 2000);
  assert.equal(summary.attemptMs.n, 2);
});

await test("tokens do not double count cached input or reasoning and flag missing usage", () => {
  const m: Measurement = {
    stage: "query",
    model: "luna",
    durationMs: 1,
    firstEventMs: null,
    firstMessageEventMs: null,
    threadId: null,
    error: null,
    usage: {
      inputTokens: 100,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 5,
      outputTokens: 20,
      reasoningOutputTokens: 8,
    },
  };
  const s = tokenSummary([m, { ...m, usage: null }]);
  assert.equal(s.knownTotalTokens, 120);
  assert.equal(s.missingUsageCalls, 1);
  assert.deepEqual(distribution([]), { n: 0, mean: null, p50: null, p95: null });
  assert.equal(distribution([10, 20, 30, 40]).p95, 40);
});

await test("reports retain incomplete execution and include failures in pass-rate denominator", async () => {
  const s = caseById("table-units");
  const good = await runScenario(s, 1, fakeModel(s), settings, signal);
  const bad = { ...good, status: "failed" as const, mode: "live" as const };
  const dir = await mkdtemp(join(tmpdir(), "eval-report-test-"));
  try {
    const summary = await writeReport(dir, [good, bad], 3);
    assert.equal(summary.complete, false);
    assert.equal(summary.all.passRate, 0.5);
    assert.equal(summary.live.failed, 1);
    assert.equal(summary.fixture.passed, 1);
    assert.ok((await readFile(join(dir, "results.csv"), "utf8")).includes("research_input_tokens"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
