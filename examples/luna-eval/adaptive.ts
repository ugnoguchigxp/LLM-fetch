import type { LlmFetchClient, RetrievedDocument, SearchHit } from "../../dist/index.js";
import { researchDecisionSchema, researchPlanSchema } from "./contracts.ts";
import type { Model, ResearchPlan, ResearchDecision } from "./contracts.ts";
import type { Result, ToolTrace } from "./pipeline.ts";
import { answerEvidence } from "./pipeline.ts";
import { errorMessage } from "./model.ts";
import { researchDecisionInstruction, researchPlanInstruction } from "./prompts.ts";

export const adaptivePolicy = {
  targetMs: 10_000,
  answerReserveMs: 3_500,
  // Preserve one real retrieval opportunity when model planning already consumes
  // the target. Such overruns are measured, never reported as meeting the target.
  minimumRetrievalWindowMs: 15_000,
  maxReads: 3,
  maxSearches: 3,
  maxDecisions: 3,
  maxConcurrent: 2,
  documentCharacters: 20_000,
  retainedCharacters: 100_000,
};
export type AdaptivePolicy = typeof adaptivePolicy;
export type ResearchState = {
  plan: ResearchPlan;
  policy: AdaptivePolicy;
  decisions: ResearchDecision[];
  actionErrors: string[];
  retrievalDeadlineMs: number;
  targetOverrunBeforeRetrieval: boolean;
  stopReason: "sufficient" | "insufficient" | "budget" | "cancelled" | null;
  evidenceUsed: ReturnType<typeof answerEvidence> | null;
};
const prompt = (instruction: string, data: unknown) =>
  `${instruction}\n\n入力データ(JSON):\n${JSON.stringify(data)}`;

export function compactDocument(d: RetrievedDocument) {
  return {
    type: "fetch_content_result" as const,
    security: {
      trust: "untrusted" as const,
      tainted: true as const,
      decision: d.security.decision,
      warningCategories: [
        ...new Set(
          d.security.findings.filter((f) => f.category !== "benign_mention").map((f) => f.category),
        ),
      ],
      reasonCodes: [...(d.security.reasonCodes ?? [])],
    },
    document: { url: d.finalUrl, text: d.text, fetchedAt: d.fetchedAt, truncated: d.truncated },
  };
}
function publicError(error: unknown) {
  const e = error as { code?: string; toJSON?: () => unknown };
  return {
    code: String(e?.code ?? "UNKNOWN"),
    message: errorMessage(error),
    metadata: typeof e?.toJSON === "function" ? e.toJSON() : null,
  };
}
function canonical(url: string) {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.href;
}
// These are source constraints chosen by Luna, not a host trust exemption.
function hostMatches(url: string, hosts: string[]) {
  const host = new URL(url).hostname.toLowerCase();
  return (
    !hosts.length ||
    hosts.some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`))
  );
}

export async function adaptiveResearch(
  r: Result,
  client: LlmFetchClient,
  model: Model,
  signal: AbortSignal,
  started: number,
  policy: AdaptivePolicy = adaptivePolicy,
) {
  r.failedStage = "query";
  const plan = await model.generate(
    "query",
    prompt(researchPlanInstruction, { request: r.request }),
    researchPlanSchema,
    signal,
    r.measurements,
  );
  r.query = { rationale: plan.rationale, queries: plan.searches.map((s) => s.query) };
  const now = performance.now();
  const deadline = Math.max(
    started + policy.targetMs - policy.answerReserveMs,
    now + policy.minimumRetrievalWindowMs,
  );
  const state: ResearchState = {
    plan,
    policy,
    decisions: [],
    actionErrors: [],
    retrievalDeadlineMs: deadline - started,
    targetOverrunBeforeRetrieval: now - started > policy.targetMs - policy.answerReserveMs,
    stopReason: null,
    evidenceUsed: null,
  };
  r.research = state;
  const retrievalController = new AbortController();
  const retrievalSignal = AbortSignal.any([signal, retrievalController.signal]);
  const timer = setTimeout(
    () => retrievalController.abort(new Error("Retrieval budget exhausted")),
    Math.max(1, deadline - performance.now()),
  );
  const candidates = new Map<string, SearchHit>();
  const retained = new Map<string, { document: RetrievedDocument; shown: number }>();
  let forceFinal = false;
  const attempted = new Set<string>();
  const searched = new Set<string>();
  const pendingSearches = new Set<Promise<void>>();
  let stopCause: "sufficient" | "deadline" = "deadline";
  const active = new Map<string, { promise: Promise<void> }>();
  let searches = 0;
  let reads = 0;
  let version = 0;
  const remainingMs = () => Math.max(0, deadline - performance.now());
  const canRead = () => !retrievalSignal.aborted && reads < policy.maxReads;
  const canSearch = () => !retrievalSignal.aborted && searches < policy.maxSearches;

  const search = async (query: string) => {
    if (!canSearch() || searched.has(query)) return [];
    searches++;
    searched.add(query);
    const t: ToolTrace = {
      name: "web_search",
      input: { query, limit: 5 },
      result: null,
      error: null,
    };
    const m = {
      stage: "web_search",
      model: null,
      durationMs: 0,
      firstEventMs: null,
      firstMessageEventMs: null,
      usage: null,
      threadId: null,
      error: null as string | null,
    };
    r.trace.push(t);
    r.measurements.push(m);
    const start = performance.now();
    try {
      const hits = await client.search({ query, limit: 5, signal: retrievalSignal });
      t.result = { type: "candidate_search_result", hits };
      for (const hit of hits)
        if (!candidates.has(canonical(hit.url))) candidates.set(canonical(hit.url), hit);
      return hits;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      t.error = publicError(error);
      m.error = t.error.message;
      if (retrievalController.signal.aborted) t.cancellation = stopCause;
      return [];
    } finally {
      m.durationMs = performance.now() - start;
      version++;
    }
  };
  const launch = (url: string) => {
    const key = canonical(url);
    if (!canRead() || active.size >= policy.maxConcurrent || attempted.has(key)) return;
    if (!candidates.has(key)) throw new Error("Requested URL absent from search results");
    attempted.add(key);
    reads++;
    const readSignal = retrievalSignal;
    const t: ToolTrace = {
      name: "fetch_content",
      input: {
        url,
        maxCharacters: policy.retainedCharacters,
        shownCharacters: policy.documentCharacters,
      },
      result: null,
      error: null,
    };
    const m = {
      stage: "fetch_content",
      model: null,
      durationMs: 0,
      firstEventMs: null,
      firstMessageEventMs: null,
      usage: null,
      threadId: null,
      error: null as string | null,
    };
    r.trace.push(t);
    r.measurements.push(m);
    const start = performance.now();
    const promise = (async () => {
      try {
        const d = await client.read({
          url,
          maxCharacters: policy.retainedCharacters,
          requestedUse: "answer_with_citation",
          render: "never",
          signal: readSignal,
        });
        retained.set(key, { document: d, shown: policy.documentCharacters });
        retained.set(canonical(d.finalUrl), retained.get(key)!);
        t.result = compactDocument({
          ...d,
          text: d.text.slice(0, policy.documentCharacters),
          truncated: d.truncated || d.text.length > policy.documentCharacters,
        });
        t.audit = { security: d.security };
      } catch (error) {
        t.error = publicError(error);
        m.error = t.error.message;
        if (retrievalController.signal.aborted) t.cancellation = stopCause;
        else if (signal.aborted) t.cancellation = "caller";
      } finally {
        m.durationMs = performance.now() - start;
        version++;
        active.delete(key);
      }
    })();
    active.set(key, { promise });
  };
  const waitForOne = async () => {
    if (active.size || pendingSearches.size)
      await Promise.race([...[...active.values()].map((a) => a.promise), ...pendingSearches]);
    signal.throwIfAborted();
  };
  const finishReads = async (reason: "sufficient" | "deadline") => {
    const pending = [...active.values()];
    stopCause = reason;
    retrievalController.abort(
      new Error(
        reason === "sufficient"
          ? "Sufficient evidence; unused retrieval cancelled"
          : "Retrieval stopped at budget",
      ),
    );
    // Drain once before persistence: cancelled guard usage may remain unknown,
    // but no measurement is allowed to mutate after the result is returned.
    await Promise.allSettled([...pending.map((a) => a.promise), ...pendingSearches]);
  };
  try {
    // Independent search groups can start together. Each group initially contributes
    // at most one candidate; rank is used only inside the model's source constraint.
    for (const s of plan.searches) {
      const task = (async () => {
        const hits = await search(s.query);
        const first = hits.find(
          (h) => hostMatches(h.url, s.allowedHosts) && !attempted.has(canonical(h.url)),
        );
        if (first) launch(first.url);
        if (plan.searches.length === 1 && plan.initialConcurrency === 2) {
          const second = hits.find(
            (h) => hostMatches(h.url, s.allowedHosts) && !attempted.has(canonical(h.url)),
          );
          if (second) launch(second.url);
        }
      })();
      pendingSearches.add(task);
      void task.then(
        () => pendingSearches.delete(task),
        () => pendingSearches.delete(task),
      );
    }
    while (
      !r.trace.some((t) => t.name === "fetch_content" && (t.result || t.error)) &&
      (active.size || pendingSearches.size)
    )
      await waitForOne();
    r.selection = { rationale: plan.rationale, urls: [...attempted] };
    for (let turn = 0; turn < policy.maxDecisions; turn++) {
      signal.throwIfAborted();
      const last = turn === policy.maxDecisions - 1;
      const continuation =
        !last &&
        !forceFinal &&
        (canRead() ||
          canSearch() ||
          active.size > 0 ||
          pendingSearches.size > 0 ||
          [...retained.values()].some((v) => v.shown < v.document.text.length));
      const evidence = answerEvidence(r.trace);
      const snapshot = structuredClone(evidence);
      const snapshotVersion = version;
      r.failedStage = "answer";
      const decision = await model.generate(
        "answer",
        prompt(researchDecisionInstruction, {
          request: r.request,
          requirements: plan.requirements.map((requirement, i) => ({ number: i + 1, requirement })),
          evidence: snapshot,
          candidates: [...candidates.values()]
            .filter((h) => !attempted.has(canonical(h.url)))
            .map((h) => ({
              url: h.url,
              title: h.title.slice(0, 200),
              snippet: h.snippet.slice(0, 500),
            })),
          searchedQueries: [...searched],
          attemptedUrls: [...attempted],
          sourceViews: [...new Set(retained.values())].map((v) => ({
            url: v.document.finalUrl,
            shownCharacters: Math.min(v.shown, v.document.text.length),
            availableCharacters: v.document.text.length,
            truncated: v.document.truncated || v.shown < v.document.text.length,
          })),
          actionErrors: state.actionErrors,
          pendingUrls: [...active.keys()],
          pendingSearches: pendingSearches.size,
          canContinue: continuation,
          remaining: {
            milliseconds: remainingMs(),
            reads: policy.maxReads - reads,
            searches: policy.maxSearches - searches,
          },
        }),
        researchDecisionSchema,
        signal,
        r.measurements,
      );
      state.decisions.push(decision);
      const covered = decision.coverage.map((c) => c.requirement);
      if (
        covered.length !== plan.requirements.length ||
        new Set(covered).size !== covered.length ||
        covered.some((n) => n > plan.requirements.length)
      )
        throw new Error("Coverage requirement mismatch");
      const seenUrls = new Set(snapshot.documents.map((d) => d.url));
      for (const item of decision.coverage)
        for (const url of item.urls)
          if (!seenUrls.has(url)) throw new Error("Coverage cites unseen evidence");
      if (decision.action === "answer") {
        if (!decision.answer) throw new Error("Answer action is missing answer");
        r.answer = decision.answer;
        state.evidenceUsed = snapshot;
        if (!r.answer.insufficientEvidence && decision.coverage.some((c) => c.status === "missing"))
          r.contractFailures.push("Evidence declared sufficient with uncovered requirements");
        // Citations must refer to the immutable input of this answer, not a source
        // that happened to complete during generation.
        for (const c of r.answer.citations)
          if (!seenUrls.has(c.url))
            r.contractFailures.push(`Citation absent from answer input: ${c.url}`);
        r.pipelineMs = performance.now() - started;
        state.stopReason = r.answer.insufficientEvidence
          ? retrievalSignal.aborted
            ? "budget"
            : "insufficient"
          : "sufficient";
        await finishReads(r.answer.insufficientEvidence ? "deadline" : "sufficient");
        break;
      }
      if (decision.answer !== null) throw new Error("Research action unexpectedly contains answer");
      if (!continuation) throw new Error("Model requested research after budget exhausted");
      if (decision.action === "read") {
        if (!decision.urls.length) throw new Error("Read action has no URLs");
        for (const url of decision.urls) {
          const cached = retained.get(canonical(url));
          if (cached && cached.shown < cached.document.text.length) {
            cached.shown = Math.min(
              cached.document.text.length,
              cached.shown + policy.documentCharacters,
            );
            r.trace.push({
              name: "expand_content",
              input: { url, shownCharacters: cached.shown },
              error: null,
              result: compactDocument({
                ...cached.document,
                text: cached.document.text.slice(0, cached.shown),
                truncated: cached.document.truncated || cached.shown < cached.document.text.length,
              }),
            });
            version++;
          } else if (attempted.has(canonical(url))) {
            state.actionErrors.push(
              "This URL was already read or failed; no duplicate HTTP request was made. Answer from available evidence.",
            );
            forceFinal = true;
          } else launch(url);
        }
      } else if (decision.action === "search") {
        if (!decision.query) throw new Error("Search action missing query");
        if (searched.has(decision.query)) {
          state.actionErrors.push(
            "This query was already searched; the duplicate was not executed. Answer from available evidence and explain any uncertainty.",
          );
          forceFinal = true;
          continue;
        }
        // New search results are selected by Luna on the next continuation. No
        // host keyword rule is allowed to infer the intended publisher.
        await search(decision.query);
      } else if (!active.size && !pendingSearches.size && version === snapshotVersion)
        throw new Error("Wait action without pending retrieval");
      r.selection.urls = [...attempted];
      if (version === snapshotVersion) await waitForOne();
    }
    if (!r.answer) throw new Error("Research loop ended without answer");
    r.failedStage = null;
  } finally {
    clearTimeout(timer);
    if (active.size || pendingSearches.size) await finishReads("deadline");
    r.selection = { rationale: plan.rationale, urls: [...attempted] };
  }
}
