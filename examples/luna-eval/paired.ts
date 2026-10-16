import type { LlmFetchClient, SearchHit } from "../../dist/index.js";
import { pairedDecisionSchema, pairedPlanSchema } from "./contracts.ts";
import type { Answer, Measurement, Model, PairedDecision, PairedPlan } from "./contracts.ts";
import { compactDocument } from "./adaptive.ts";
import { answerEvidence } from "./pipeline.ts";
import type { Result, ToolTrace } from "./pipeline.ts";
import { errorMessage } from "./model.ts";
import { pairedDecisionInstruction, pairedPlanInstruction } from "./prompts.ts";

export const pairedPolicy = {
  hedgeAfterMs: 10_000,
  searchLimit: 10,
  documentCharacters: 100_000,
};
export type PairedPolicy = typeof pairedPolicy;
type Evidence = ReturnType<typeof answerEvidence>;
export type PairedState = {
  plan: PairedPlan;
  policy: PairedPolicy;
  batches: {
    atMs: number;
    reason: "initial" | "hedge" | "insufficient" | "failed";
    urls: string[];
    activeReads: number;
  }[];
  decisions: {
    startedMs: number;
    completedMs: number;
    evidenceUrls: string[];
    canContinue: boolean;
    response: PairedDecision;
    validationError?: string;
  }[];
  firstMarkdownMs: number | null;
  firstEvaluationMs: number | null;
  peakActiveReads: number;
  stopReason: "sufficient" | "exhausted" | "cancelled" | "error" | null;
  evidenceUsed: Evidence | null;
};
const prompt = (instruction: string, data: unknown) =>
  `${instruction}\n\n入力データ(JSON):\n${JSON.stringify(data)}`;
const normalized = (s: string) => s.replace(/\s+/gu, " ").trim();
const canonical = (url: string) => {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.href;
};

// Validate references and the stopping contract, not semantic entailment (Luna's job).
export function validateDecision(
  decision: PairedDecision,
  plan: PairedPlan,
  evidence: Evidence,
  canContinue: boolean,
) {
  const ids = decision.coverage.map((c) => c.requirement);
  if (
    ids.length !== plan.requirements.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => id < 1 || id > plan.requirements.length)
  )
    throw new Error("Requirement coverage mismatch");
  for (const c of decision.coverage) {
    if (c.status === "supported" && !c.evidence.length)
      throw new Error("Supported requirement without evidence");
    for (const e of c.evidence) {
      const d = evidence.documents.find((d) => d.url === e.url);
      if (!d || !normalized(d.text).includes(normalized(e.quote)))
        throw new Error(`Evidence quote absent from answer input: ${e.url}`);
    }
  }
  if (
    decision.sufficient &&
    (decision.coverage.some((c) => c.status !== "supported") ||
      !decision.answer ||
      decision.answer.insufficientEvidence ||
      !decision.answer.citationRefs.length)
  )
    throw new Error("Sufficient decision violates evidence contract");
  if (
    !decision.sufficient &&
    (canContinue ? decision.answer !== null : !decision.answer?.insufficientEvidence)
  )
    throw new Error("Insufficient decision violates continuation contract");
  for (const ref of decision.answer?.citationRefs ?? []) {
    if (
      !decision.coverage.find((c) => c.requirement === ref.requirement)?.evidence[ref.evidence - 1]
    )
      throw new Error("Citation reference absent from quoted evidence");
  }
}

// Claims are generated once; citations reference their validated evidence by number.
export function decisionAnswer(decision: PairedDecision): Answer | null {
  if (!decision.answer) return null;
  const { citationRefs, ...answer } = decision.answer;
  return {
    ...answer,
    citations: citationRefs.map((ref) => {
      const e = decision.coverage.find((c) => c.requirement === ref.requirement)!.evidence[
        ref.evidence - 1
      ]!;
      return { url: e.url, claim: e.claim };
    }),
  };
}

export async function pairedResearch(
  r: Result,
  client: LlmFetchClient,
  model: Model,
  signal: AbortSignal,
  started: number,
  policy: PairedPolicy = pairedPolicy,
) {
  r.failedStage = "query";
  const plan = await model.generate(
    "query",
    prompt(pairedPlanInstruction, { request: r.request }),
    pairedPlanSchema,
    signal,
    r.measurements,
  );
  r.query = { rationale: plan.rationale, queries: plan.searches.map((s) => s.query) };
  const state: PairedState = {
    plan,
    policy,
    batches: [],
    decisions: [],
    firstMarkdownMs: null,
    firstEvaluationMs: null,
    peakActiveReads: 0,
    stopReason: null,
    evidenceUsed: null,
  };
  r.paired = state;
  const controller = new AbortController();
  const retrievalSignal = AbortSignal.any([signal, controller.signal]);
  const tasks = new Set<Promise<void>>();
  const active = new Set<string>();
  const candidates = new Map<string, { hit: SearchHit; search: number }>();
  const attempted = new Set<string>();
  let pendingSearches = 0;
  let version = 0;
  let evidenceVersion = 0;
  let evaluatedVersion = -1;
  let lastTerminal = false;
  let nextBatch: PairedState["batches"][number]["reason"] | null = "initial";
  let hedgeAt = Infinity;
  let wake: (() => void) | undefined;
  let assessment: Promise<void> | null = null;
  let outcome: { response: PairedDecision; evidence: Evidence; canContinue: boolean } | null = null;
  let assessmentError: unknown;
  const elapsed = () => performance.now() - started;
  const notify = () => {
    version++;
    wake?.();
  };
  const abortWake = () => notify();
  signal.addEventListener("abort", abortWake, { once: true });
  function track(task: () => Promise<void>) {
    // Defer execution until the task has been registered, including synchronous failures.
    const p = Promise.resolve()
      .then(task)
      .finally(() => {
        tasks.delete(p);
        notify();
      });
    tasks.add(p);
  }
  function trace(name: string, input: Record<string, unknown>) {
    const t: ToolTrace = { name, input, result: null, error: null };
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
    r.trace.push(t);
    r.measurements.push(m);
    return { t, m, at: performance.now() };
  }
  function failure(t: ToolTrace, m: Measurement, error: unknown) {
    const e = error as { code?: string; toJSON?: () => unknown };
    t.error = {
      code: String(e?.code ?? "UNKNOWN"),
      message: errorMessage(error),
      metadata: typeof e?.toJSON === "function" ? e.toJSON() : null,
    };
    m.error = t.error.message;
    if (signal.aborted)
      t.cancellation = signal.reason?.name === "TimeoutError" ? "deadline" : "caller";
    else if (controller.signal.aborted)
      t.cancellation = state.stopReason === "sufficient" ? "sufficient" : "error";
  }
  const available = () =>
    [...candidates.values()]
      .filter(({ hit }) => !attempted.has(canonical(hit.url)))
      .sort((a, b) => a.hit.rank - b.hit.rank || a.search - b.search);
  function launchBatch(reason: PairedState["batches"][number]["reason"]) {
    const batch = available().slice(0, 2);
    if (!batch.length) return false;
    for (const { hit } of batch) {
      const key = canonical(hit.url);
      attempted.add(key);
      active.add(key);
      const { t, m, at } = trace("fetch_content", {
        url: hit.url,
        maxCharacters: policy.documentCharacters,
      });
      track(async () => {
        try {
          const document = await client.read({
            url: hit.url,
            maxCharacters: policy.documentCharacters,
            requestedUse: "answer_with_citation",
            render: "never",
            signal: retrievalSignal,
          });
          // A late result after cancellation must never change the frozen answer snapshot.
          retrievalSignal.throwIfAborted();
          t.result = compactDocument(document);
          t.audit = { security: document.security };
          state.firstMarkdownMs ??= elapsed();
          evidenceVersion++;
          hedgeAt = performance.now() + policy.hedgeAfterMs;
        } catch (error) {
          failure(t, m, error);
        } finally {
          m.durationMs = performance.now() - at;
          active.delete(key);
        }
      });
    }
    state.peakActiveReads = Math.max(state.peakActiveReads, active.size);
    state.batches.push({
      atMs: elapsed(),
      reason,
      urls: batch.map(({ hit }) => hit.url),
      activeReads: active.size,
    });
    hedgeAt = performance.now() + policy.hedgeAfterMs;
    nextBatch = null;
    return true;
  }
  function startAssessment(canContinue: boolean) {
    const evidence = answerEvidence(r.trace);
    evaluatedVersion = evidenceVersion;
    lastTerminal = !canContinue;
    const at = elapsed();
    state.firstEvaluationMs ??= at;
    r.failedStage = "assess";
    assessment = (async () => {
      try {
        const response = await model.generate(
          "assess",
          prompt(pairedDecisionInstruction, {
            request: r.request,
            requirements: plan.requirements,
            evidence,
            canContinue,
            pendingUrls: [...active],
            remainingCandidates: available().length,
          }),
          pairedDecisionSchema,
          signal,
          r.measurements,
        );
        const record: PairedState["decisions"][number] = {
          startedMs: at,
          completedMs: elapsed(),
          evidenceUrls: evidence.documents.map((d) => d.url),
          canContinue,
          response,
        };
        state.decisions.push(record);
        try {
          validateDecision(response, plan, evidence, canContinue);
        } catch (error) {
          record.validationError = errorMessage(error);
          throw error;
        }
        outcome = { response, evidence, canContinue };
      } catch (error) {
        assessmentError = error;
      } finally {
        assessment = null;
        notify();
      }
    })();
  }
  async function wait(observed: number) {
    if (observed !== version || signal.aborted) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      };
      wake = finish;
      if (available().length && Number.isFinite(hedgeAt))
        timer = setTimeout(finish, Math.max(1, hedgeAt - performance.now()));
    });
  }
  try {
    plan.searches.forEach((search, index) => {
      pendingSearches++;
      track(async () => {
        const { t, m, at } = trace("web_search", {
          query: search.query,
          limit: policy.searchLimit,
        });
        try {
          const hits = await client.search({
            query: search.query,
            limit: policy.searchLimit,
            signal: retrievalSignal,
          });
          retrievalSignal.throwIfAborted();
          t.result = { type: "candidate_search_result", hits };
          for (const hit of hits) {
            const host = new URL(hit.url).hostname.toLowerCase();
            if (
              search.allowedHosts.length &&
              !search.allowedHosts.some(
                (h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`),
              )
            )
              continue;
            const key = canonical(hit.url);
            if (!candidates.has(key)) candidates.set(key, { hit, search: index });
          }
        } catch (error) {
          failure(t, m, error);
        } finally {
          m.durationMs = performance.now() - at;
          pendingSearches--;
        }
      });
    });
    while (true) {
      signal.throwIfAborted();
      const observed = version;
      if (assessmentError) throw assessmentError;
      if (outcome) {
        const done = outcome as {
          response: PairedDecision;
          evidence: Evidence;
          canContinue: boolean;
        };
        outcome = null;
        if (done.response.sufficient || !done.canContinue) {
          r.answer = decisionAnswer(done.response);
          state.evidenceUsed = done.evidence;
          state.stopReason = done.response.sufficient ? "sufficient" : "exhausted";
          r.pipelineMs = elapsed();
          r.failedStage = null;
          break;
        }
        nextBatch = "insufficient";
      }
      if (nextBatch) launchBatch(nextBatch);
      if (available().length && performance.now() >= hedgeAt) launchBatch("hedge");
      // Failed reads do not count as Markdown; do not waste ten seconds when nothing is running.
      if (!active.size && available().length) launchBatch("failed");
      const canContinue = active.size > 0 || pendingSearches > 0 || available().length > 0;
      if (
        !assessment &&
        ((evidenceVersion > evaluatedVersion && evidenceVersion > 0) ||
          (!canContinue && !lastTerminal))
      ) {
        startAssessment(canContinue);
      }
      await wait(observed);
    }
  } catch (error) {
    state.stopReason = signal.aborted ? "cancelled" : "error";
    throw error;
  } finally {
    // Only sufficient answers abort speculative retrieval. Errors/caller cancellation also drain it.
    if (!controller.signal.aborted)
      controller.abort(new Error(`Retrieval stopped: ${state.stopReason}`));
    signal.removeEventListener("abort", abortWake);
    const pending: Promise<unknown>[] = [...tasks];
    if (assessment) pending.push(assessment);
    await Promise.allSettled(pending);
    r.selection = {
      rationale: "検索順位と出典条件で2件ずつ取得。本文の目的充足はLunaが評価。",
      urls: [...attempted],
    };
  }
}
