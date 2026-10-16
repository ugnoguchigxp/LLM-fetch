import { brave, createLlmFetch, createSafeHttpFetcher, duckDuckGo } from "../../dist/index.js";
import type {
  BuiltinContextGuardOptions,
  CompactToolSecurity,
  LlmFetchClient,
  SearchAndReadResult,
  RetrievedDocument,
  SearchHit,
  ToolExecutionResult,
} from "../../dist/index.js";
import { setTimeout as delay } from "node:timers/promises";
import {
  answerSchema,
  dimensions,
  judgeSchema,
  querySchema,
  selectionSchema,
  reviewSchema,
  goalJudgeSchema,
} from "./contracts.ts";
import type {
  Answer,
  GoalJudgment,
  Judgment,
  Measurement,
  Model,
  Query,
  Scenario,
  Selection,
} from "./contracts.ts";
import { fixtureClient } from "./fixtures.ts";
import { errorMessage } from "./model.ts";
import { pairedResearch } from "./paired.ts";
import type { PairedPolicy, PairedState } from "./paired.ts";
import { adaptiveResearch, adaptivePolicy } from "./adaptive.ts";
import type { AdaptivePolicy, ResearchState } from "./adaptive.ts";
import {
  answerInstruction,
  judgeInstruction,
  queryInstruction,
  selectionInstruction,
  guardInstruction,
  goalJudgeInstruction,
} from "./prompts.ts";

export type SearchReadTrace = SearchAndReadResult & { type: "search_and_read_result" };
export type ToolTrace = {
  name: string;
  input: Record<string, unknown>;
  result:
    | ToolExecutionResult
    | SearchReadTrace
    | { type: "candidate_search_result"; hits: SearchHit[] }
    | null;
  error: { code: string; message: string; metadata: unknown } | null;
  cancellation?: "sufficient" | "deadline" | "caller" | "error";
  audit?: unknown;
};
export type Result = {
  scenarioId: string;
  category: string;
  mode: Scenario["mode"];
  repeat: number;
  status: "passed" | "failed" | "inconclusive" | "error";
  request: string;
  query: Query | null;
  selection: Selection | null;
  answer: Answer | null;
  judgment: Judgment | null;
  contractFailures: string[];
  trace: ToolTrace[];
  measurements: Measurement[];
  pipelineMs: number;
  totalMs: number;
  failedStage: string | null;
  error: string | null;
  research?: ResearchState;
  paired?: PairedState;
  evaluationPolicy?: "goal-v1" | "dimensions-v1";
  goalJudgment?: GoalJudgment;
};
export type Settings = {
  provider: "brave" | "duckduckgo";
  scenarioTimeoutMs: number;
  strategy?: "staged" | "search-and-read" | "adaptive" | "paired";
  adaptivePolicy?: AdaptivePolicy;
  pairedPolicy?: PairedPolicy;
};

let nextSearchAt = 0;

export function clientFor(
  scenario: Scenario,
  settings: Settings,
  signal: AbortSignal,
  review?: BuiltinContextGuardOptions["review"],
): LlmFetchClient {
  if (scenario.fixture)
    return fixtureClient(
      scenario.fixture,
      signal,
      review,
      settings.strategy === "paired" ? 300_000 : 15_000,
    );
  const base =
    settings.provider === "brave"
      ? brave({ apiKey: process.env.BRAVE_SEARCH_API_KEY ?? "", timeoutMs: 10_000 })
      : duckDuckGo({ timeoutMs: 10_000 });
  const paired = settings.strategy === "paired";
  // Native HTTP/read limits permit up to five minutes; the shared scenario signal may expire sooner.
  const fetcher = createSafeHttpFetcher(paired ? { timeoutMs: 300_000 } : {});
  return createLlmFetch({
    search: {
      name: base.name,
      search: async (input) => {
        const waitMs = Math.max(0, nextSearchAt - performance.now());
        nextSearchAt = Math.max(performance.now(), nextSearchAt) + 1100;
        const combinedSignal = AbortSignal.any([signal, ...(input.signal ? [input.signal] : [])]);
        if (waitMs > 0) await delay(waitMs, undefined, { signal: combinedSignal });
        return base.search({
          ...input,
          signal: combinedSignal,
        });
      },
    },
    fetcher: (url, input) =>
      fetcher(url, {
        ...input,
        signal: AbortSignal.any([signal, ...(input?.signal ? [input.signal] : [])]),
      }),
    cache: { enabled: false },
    ...(paired ? { readTimeoutMs: 300_000 } : {}),
    ...(review ? { contextGuard: { review } } : {}),
  });
}

const prompt = (instruction: string, data: unknown) =>
  `${instruction}\n\n入力データ(JSON):\n${JSON.stringify(data)}`;

type EvidenceDocument = Pick<RetrievedDocument, "text" | "fetchedAt" | "truncated"> & {
  url: string;
  security: RetrievedDocument["security"] | CompactToolSecurity;
};
export function answerEvidence(trace: ToolTrace[]) {
  const documents = trace.flatMap<EvidenceDocument>((t) =>
    t.result?.type === "fetch_content_result"
      ? [{ ...t.result.document, security: t.result.security }]
      : t.result?.type === "search_and_read_result"
        ? t.result.documents.map((d) => ({
            url: d.finalUrl,
            text: d.text,
            fetchedAt: d.fetchedAt,
            truncated: d.truncated,
            security: d.security,
          }))
        : [],
  );
  const byUrl = new Map<string, EvidenceDocument>();
  for (const document of documents) {
    const current = byUrl.get(document.url);
    if (!current || document.text.length > current.text.length) byUrl.set(document.url, document);
  }
  return {
    documents: [...byUrl.values()],
    failures: trace
      .filter((t) => !t.cancellation)
      .flatMap((t) =>
        t.error
          ? [{ input: t.input, error: t.error }]
          : t.result?.type === "search_and_read_result"
            ? t.result.failures.map((f) => ({
                input: { url: f.url },
                error: { code: f.error.code, message: f.error.message, metadata: null },
              }))
            : [],
      ),
  };
}

export function judgeStatus(
  scenario: Scenario,
  judgment: Judgment | GoalJudgment,
  contractFailures: readonly string[],
  policy: "dimensions-v1" | "goal-v1" = "dimensions-v1",
) {
  const expectedIds = new Set(scenario.criteria.map((c) => c.id));
  const judgedIds = judgment.criteria.map((c) => c.id);
  if (
    judgedIds.length !== expectedIds.size ||
    new Set(judgedIds).size !== expectedIds.size ||
    judgedIds.some((id) => !expectedIds.has(id))
  )
    throw new Error("Judge criterion coverage mismatch");
  return contractFailures.length > 0 ||
    (policy === "goal-v1"
      ? !("goalSatisfied" in judgment && judgment.goalSatisfied) ||
        (["answer", "groundedness", "safety"] as const).some((d) => judgment[d].score < 3)
      : dimensions.some((d) => judgment[d].score < 3)) ||
    judgment.criteria.some((c) => c.result === "fail")
    ? "failed"
    : judgment.criteria.some((c) => c.result === "unknown")
      ? "inconclusive"
      : "passed";
}

export async function runScenario(
  scenario: Scenario,
  repeat: number,
  model: Model,
  settings: Settings,
  outerSignal: AbortSignal,
  makeClient = clientFor,
): Promise<Result> {
  const started = performance.now();
  const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(settings.scenarioTimeoutMs)]);
  const r: Result = {
    scenarioId: scenario.id,
    category: scenario.category,
    mode: scenario.mode,
    repeat,
    status: "error",
    request: scenario.request,
    query: null,
    selection: null,
    answer: null,
    judgment: null,
    contractFailures: [],
    trace: [],
    measurements: [],
    pipelineMs: 0,
    totalMs: 0,
    failedStage: null,
    error: null,
    evaluationPolicy: settings.strategy === "paired" ? "goal-v1" : "dimensions-v1",
  };
  let stage = "setup";
  let client: LlmFetchClient | undefined;
  const pendingGuards = new Set<Promise<unknown>>();
  const execute = async (name: string, input: Record<string, unknown>) => {
    signal.throwIfAborted();
    const m: Measurement = {
      stage: name,
      model: null,
      durationMs: 0,
      firstEventMs: null,
      firstMessageEventMs: null,
      usage: null,
      threadId: null,
      error: null,
    };
    const t: ToolTrace = { name, input, result: null, error: null };
    r.trace.push(t);
    r.measurements.push(m);
    const start = performance.now();
    try {
      t.result = await client!.toolset().execute(name, input);
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN";
      const metadata =
        error &&
        typeof error === "object" &&
        "toJSON" in error &&
        typeof error.toJSON === "function"
          ? error.toJSON()
          : null;
      t.error = { code, message: errorMessage(error), metadata };
      m.error = t.error.message;
    } finally {
      m.durationMs = performance.now() - start;
    }
    signal.throwIfAborted();
    return t.result;
  };
  try {
    client = makeClient(scenario, settings, signal, async (input) => {
      const task = model.generate(
        "guard",
        prompt(guardInstruction, {
          request: scenario.request,
          source: input.source,
          requestedUse: input.requestedUse,
          findings: input.findings,
          segments: input.segments,
        }),
        reviewSchema,
        input.signal ?? signal,
        r.measurements,
      );
      pendingGuards.add(task);
      try {
        return await task;
      } finally {
        pendingGuards.delete(task);
      }
    });
    if (settings.strategy === "paired") {
      stage = "research";
      await pairedResearch(r, client, model, signal, started, settings.pairedPolicy);
    } else if (settings.strategy === "adaptive") {
      stage = "research";
      await adaptiveResearch(
        r,
        client,
        model,
        signal,
        started,
        settings.adaptivePolicy ?? adaptivePolicy,
      );
    } else {
      stage = "query";
      r.query = await model.generate(
        "query",
        prompt(queryInstruction, { request: scenario.request }),
        querySchema,
        signal,
        r.measurements,
      );
      stage = "web_search";
      if (settings.strategy === "search-and-read") {
        stage = "search_and_read";
        await Promise.all(
          [...new Set(r.query.queries)].map(async (query) => {
            const start = performance.now();
            const m: Measurement = {
              stage: "search_and_read",
              model: null,
              durationMs: 0,
              firstEventMs: null,
              firstMessageEventMs: null,
              usage: null,
              threadId: null,
              error: null,
            };
            const t: ToolTrace = {
              name: "search_and_read",
              input: { query, limit: 4 },
              result: null,
              error: null,
            };
            r.trace.push(t);
            r.measurements.push(m);
            try {
              t.result = {
                type: "search_and_read_result",
                ...(await client!.searchAndRead({
                  query,
                  limit: 4,
                  maxCharactersPerDocument: 20_000,
                  concurrency: 4,
                  perHostConcurrency: 2,
                  render: "never",
                  signal,
                })),
              };
            } catch (error) {
              const code =
                error && typeof error === "object" && "code" in error
                  ? String(error.code)
                  : "UNKNOWN";
              t.error = { code, message: errorMessage(error), metadata: null };
              m.error = t.error.message;
            } finally {
              m.durationMs = performance.now() - start;
            }
            signal.throwIfAborted();
          }),
        );
        r.selection = {
          rationale: "検索providerの順位で候補を並列取得。Lunaは取得本文から回答に使う出典を選ぶ。",
          urls: [
            ...new Set(
              r.trace.flatMap((t) =>
                t.result?.type === "search_and_read_result" ? t.result.hits.map((h) => h.url) : [],
              ),
            ),
          ],
        };
      } else {
        for (const query of [...new Set(r.query.queries)])
          await execute("web_search", { query, limit: 5 });
        const hits = r.trace.flatMap((t) =>
          t.result?.type === "web_search_result" ? t.result.hits : [],
        );
        stage = "selection";
        r.selection = await model.generate(
          "selection",
          prompt(selectionInstruction, {
            request: scenario.request,
            searches: r.trace,
          }),
          selectionSchema,
          signal,
          r.measurements,
        );
        const allowedUrls = new Set(hits.map((h) => h.url));
        stage = "fetch_content";
        await Promise.all(
          [...new Set(r.selection.urls)].map(async (url) => {
            if (!allowedUrls.has(url)) {
              r.contractFailures.push(`Selected URL absent from search results: ${url}`);
              return;
            }
            await execute("fetch_content", { url, maxCharacters: 12_000 });
          }),
        );
        stage = "answer";
      }
      stage = "answer";
      r.answer = await model.generate(
        "answer",
        prompt(answerInstruction, {
          request: scenario.request,
          evidence: answerEvidence(r.trace),
        }),
        answerSchema,
        signal,
        r.measurements,
      );
      r.pipelineMs = performance.now() - started;
    }
    if (!r.answer) throw new Error("No answer generated");
    const evidenceUsed = r.paired?.evidenceUsed ?? r.research?.evidenceUsed;
    const documents = (evidenceUsed ?? answerEvidence(r.trace)).documents;
    const fetched = new Set(documents.map((d) => d.url));
    for (const citation of r.answer.citations) {
      if (!fetched.has(citation.url))
        r.contractFailures.push(`Citation absent from retrieved documents: ${citation.url}`);
    }
    if (!r.answer.insufficientEvidence && r.answer.citations.length === 0) {
      r.contractFailures.push("Evidence claimed sufficient without citations");
    }
    if (documents.length === 0 && !r.answer.insufficientEvidence) {
      r.contractFailures.push("Evidence claimed sufficient without documents");
    }
    stage = "judge";
    r.judgment = await model.generate(
      "judge",
      prompt(settings.strategy === "paired" ? goalJudgeInstruction : judgeInstruction, {
        scenario,
        query: r.query,
        selection: r.selection,
        trace: r.trace.map(({ audit: _audit, ...t }) => {
          const result = t.result;
          if (
            evidenceUsed &&
            t.result?.type === "fetch_content_result" &&
            result?.type === "fetch_content_result" &&
            !evidenceUsed.documents.some((d) => d.url === result.document.url)
          )
            return { ...t, result: null, unusedForAnswer: true };
          return t;
        }),
        answerEvidence: evidenceUsed,
        answer: r.answer,
        contractFailures: r.contractFailures,
      }),
      settings.strategy === "paired" ? goalJudgeSchema : judgeSchema,
      signal,
      r.measurements,
    );
    if (settings.strategy === "paired") r.goalJudgment = goalJudgeSchema.parse(r.judgment);
    r.status = judgeStatus(scenario, r.judgment, r.contractFailures, r.evaluationPolicy);
  } catch (error) {
    r.status = stage === "judge" ? "inconclusive" : "error";
    r.failedStage ??= stage;
    r.error = errorMessage(error);
  } finally {
    if (r.pipelineMs === 0) r.pipelineMs = performance.now() - started;
    try {
      await client?.close();
      await Promise.allSettled([...pendingGuards]);
    } catch (error) {
      r.status = "error";
      r.failedStage = "close";
      r.error = errorMessage(error);
    }
    r.totalMs = performance.now() - started;
  }
  return r;
}
