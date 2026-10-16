import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dimensions } from "./contracts.ts";
import type { Measurement } from "./contracts.ts";
import type { Result } from "./pipeline.ts";

export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) =>
    sorted.length ? sorted[Math.ceil(p * sorted.length) - 1]! : null;
  return {
    n: sorted.length,
    mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    p50: percentile(0.5),
    p95: percentile(0.95),
  };
}

export function tokenSummary(measurements: Measurement[]) {
  const modelCalls = measurements.filter((m) => m.model !== null);
  const known = modelCalls.flatMap((m) => (m.usage ? [m.usage] : []));
  return {
    calls: modelCalls.length,
    knownCalls: known.length,
    missingUsageCalls: modelCalls.length - known.length,
    // Input includes cached input. Reasoning is a subset of output, not an extra charge here.
    inputTokens: known.reduce((sum, u) => sum + u.inputTokens, 0),
    cachedInputTokens: known.reduce((sum, u) => sum + u.cachedInputTokens, 0),
    cacheWriteInputTokens: known.every((u) => u.cacheWriteInputTokens !== null)
      ? known.reduce((sum, u) => sum + u.cacheWriteInputTokens!, 0)
      : null,
    outputTokens: known.reduce((sum, u) => sum + u.outputTokens, 0),
    reasoningOutputTokens: known.every((u) => u.reasoningOutputTokens !== null)
      ? known.reduce((sum, u) => sum + u.reasoningOutputTokens!, 0)
      : null,
    knownTotalTokens: known.reduce((sum, u) => sum + u.inputTokens + u.outputTokens, 0),
  };
}

export function summarize(results: Result[]) {
  const measured = results.flatMap((r) => r.measurements);
  const passed = results.filter((r) => r.status === "passed").length;
  const stages = [...new Set(measured.map((m) => m.stage))];
  const combined = results
    .flatMap((r) => r.trace)
    .flatMap((t) => (t.result?.type === "search_and_read_result" ? [t.result] : []));
  const codes = [
    ...results
      .flatMap((r) => r.trace)
      .flatMap((t) => (t.error && !t.cancellation ? [t.error.code] : [])),
    ...combined.flatMap((r) => r.failures.map((f) => f.error.code)),
  ];
  return {
    evaluationPolicies: [...new Set(results.map((r) => r.evaluationPolicy ?? "dimensions-v1"))],
    n: results.length,
    passed,
    failed: results.filter((r) => r.status === "failed").length,
    inconclusive: results.filter((r) => r.status === "inconclusive").length,
    errors: results.filter((r) => r.status === "error").length,
    passRate: results.length ? passed / results.length : null,
    latency: {
      targetMs: 10_000,
      completedAnswers: results.filter((r) => r.answer !== null).length,
      withinTarget: results.filter((r) => r.answer !== null && r.pipelineMs <= 10_000).length,
      passedWithinTarget: results.filter((r) => r.status === "passed" && r.pipelineMs <= 10_000)
        .length,
    },
    pipelineMs: distribution(results.filter((r) => r.answer !== null).map((r) => r.pipelineMs)),
    attemptMs: distribution(results.map((r) => r.pipelineMs)),
    totalMs: distribution(results.map((r) => r.totalMs)),
    tokens: {
      researcher: tokenSummary(measured.filter((m) => m.stage !== "judge")),
      judge: tokenSummary(measured.filter((m) => m.stage === "judge")),
      all: tokenSummary(measured),
    },
    stages: Object.fromEntries(
      stages.map((stage) => [
        stage,
        {
          durationMs: distribution(
            measured.filter((m) => m.stage === stage).map((m) => m.durationMs),
          ),
          tokens: tokenSummary(measured.filter((m) => m.stage === stage)),
        },
      ]),
    ),
    quality: Object.fromEntries(
      dimensions.map((d) => [
        d,
        distribution(results.flatMap((r) => (r.judgment ? [r.judgment[d].score] : []))),
      ]),
    ),
    retrieval: {
      firstMarkdownMs: distribution(
        results.flatMap((r) =>
          r.paired?.firstMarkdownMs == null ? [] : [r.paired.firstMarkdownMs],
        ),
      ),
      firstEvaluationMs: distribution(
        results.flatMap((r) =>
          r.paired?.firstEvaluationMs == null ? [] : [r.paired.firstEvaluationMs],
        ),
      ),
      peakActiveReads: distribution(
        results.flatMap((r) => (r.paired ? [r.paired.peakActiveReads] : [])),
      ),
      searches:
        results.flatMap((r) => r.trace).filter((t) => t.name === "web_search").length +
        results.flatMap((r) => r.trace).filter((t) => t.name === "search_and_read").length,
      emptySearches:
        results
          .flatMap((r) => r.trace)
          .filter(
            (t) =>
              (t.result?.type === "web_search_result" ||
                t.result?.type === "candidate_search_result") &&
              t.result.hits.length === 0,
          ).length + combined.filter((r) => r.hits.length === 0).length,
      blockedResults: results
        .flatMap((r) => r.trace)
        .reduce(
          (n, t) => n + (t.result?.type === "web_search_result" ? t.result.blockedResultCount : 0),
          0,
        ),
      reads:
        results.flatMap((r) => r.trace).filter((t) => t.name === "fetch_content").length +
        combined.reduce((n, r) => n + r.documents.length + r.failures.length, 0),
      readFailures:
        results
          .flatMap((r) => r.trace)
          .filter((t) => t.name === "fetch_content" && t.error && !t.cancellation).length +
        combined.reduce((n, r) => n + r.failures.length, 0),
      successfulReads:
        results
          .flatMap((r) => r.trace)
          .filter((t) => t.name === "fetch_content" && t.result?.type === "fetch_content_result")
          .length + combined.reduce((n, r) => n + r.documents.length, 0),
      expandedViews: results.flatMap((r) => r.trace).filter((t) => t.name === "expand_content")
        .length,
      cancelledReads: results
        .flatMap((r) => r.trace)
        .filter((t) => t.name === "fetch_content" && t.cancellation).length,
      cancellations: Object.fromEntries(
        (["sufficient", "deadline", "caller", "error"] as const).map((reason) => [
          reason,
          results.flatMap((r) => r.trace).filter((t) => t.cancellation === reason).length,
        ]),
      ),
      readsPerScenario: distribution(
        results.map(
          (r) =>
            r.trace.filter((t) => t.name === "fetch_content").length +
            r.trace.reduce(
              (n, t) =>
                n +
                (t.result?.type === "search_and_read_result"
                  ? t.result.documents.length + t.result.failures.length
                  : 0),
              0,
            ),
        ),
      ),
      evidenceDocumentsUsed: results.reduce(
        (n, r) => n + ((r.paired?.evidenceUsed ?? r.research?.evidenceUsed)?.documents.length ?? 0),
        0,
      ),
      truncatedDocuments:
        results
          .flatMap((r) => r.trace)
          .filter((t) => t.result?.type === "fetch_content_result" && t.result.document.truncated)
          .length + combined.flatMap((r) => r.documents).filter((d) => d.truncated).length,
      errorCodes: Object.fromEntries(
        [...new Set(codes)].map((code) => [code, codes.filter((c) => c === code).length]),
      ),
    },
  };
}

const csvCell = (v: unknown) => {
  const value = String(v ?? "");
  // Prevent spreadsheet formula interpretation of arbitrary model-generated text.
  return `"${(/^[=+\-@\t\r]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;
};
const numeric = (value: number | null) => (value === null ? "—" : value.toFixed(1));

export async function writeReport(dir: string, results: Result[], planned: number) {
  const summary = {
    complete: results.length === planned,
    planned,
    all: summarize(results),
    live: summarize(results.filter((r) => r.mode === "live")),
    fixture: summarize(results.filter((r) => r.mode === "fixture")),
    byScenario: Object.fromEntries(
      [...new Set(results.map((r) => r.scenarioId))].map((id) => [
        id,
        summarize(results.filter((r) => r.scenarioId === id)),
      ]),
    ),
  };
  await writeFile(join(dir, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  const header = [
    "scenario",
    "mode",
    "repeat",
    "status",
    "evaluation_policy",
    "pipeline_ms",
    "total_ms",
    "read_attempts",
    "successful_reads",
    "cancelled_reads",
    ...dimensions,
    "research_input_tokens",
    "research_cached_tokens",
    "research_output_tokens",
    "judge_input_tokens",
    "judge_output_tokens",
    "missing_usage_calls",
    "failed_stage",
  ];
  const rows = results.map((r) => {
    const researcher = tokenSummary(r.measurements.filter((m) => m.stage !== "judge"));
    const judge = tokenSummary(r.measurements.filter((m) => m.stage === "judge"));
    return [
      r.scenarioId,
      r.mode,
      r.repeat,
      r.status,
      r.evaluationPolicy ?? "dimensions-v1",
      r.pipelineMs,
      r.totalMs,
      summarize([r]).retrieval.reads,
      summarize([r]).retrieval.successfulReads,
      summarize([r]).retrieval.cancelledReads,
      ...dimensions.map((d) => r.judgment?.[d].score),
      researcher.inputTokens,
      researcher.cachedInputTokens,
      researcher.outputTokens,
      judge.inputTokens,
      judge.outputTokens,
      researcher.missingUsageCalls + judge.missingUsageCalls,
      r.failedStage,
    ]
      .map(csvCell)
      .join(",");
  });
  await writeFile(join(dir, "results.csv"), [header.join(","), ...rows].join("\n") + "\n", {
    mode: 0o600,
  });
  const lines = [
    "# Luna / llm-fetch evaluation",
    "",
    `実行済み ${results.length}/${planned}。全件完走: ${summary.complete ? "はい" : "いいえ"}。`,
    "",
    "合格率は失敗・判定不能・実行エラーも分母に含みます。実サイトと固定資料は別集計です。",
    `評価版: ${summary.all.evaluationPolicies.join(", ")}。goal-v1は目的充足・全シナリオ基準・回答/根拠/安全を合否に使い、検索語/取得点数は原因分析に使います。`,
    "",
    "| 区分 | 件数 | 合格 | 不合格 | 判定不能 | 実行エラー | 応答p50(ms) | 応答p95(ms) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...(["all", "live", "fixture"] as const).map((k) => {
      const s = summary[k];
      return `| ${k} | ${s.n} | ${s.passed} | ${s.failed} | ${s.inconclusive} | ${s.errors} | ${numeric(s.pipelineMs.p50)} | ${numeric(s.pipelineMs.p95)} |`;
    }),
    "",
    "| シナリオ | 回 | 結果 | 検索語 | 取得 | 回答 | 根拠 | 安全 | 応答(ms) |",
    "|---|---:|---|---:|---:|---:|---:|---:|---:|",
    ...results.map(
      (r) =>
        `| ${r.scenarioId} | ${r.repeat} | ${r.status} | ${dimensions.map((d) => r.judgment?.[d].score ?? "—").join(" | ")} | ${numeric(r.pipelineMs)} |`,
    ),
    "",
    `研究担当の既知トークン合計: ${summary.all.tokens.researcher.knownTotalTokens}。採点担当: ${summary.all.tokens.judge.knownTotalTokens}。`,
    `使用量欠落呼び出し: ${summary.all.tokens.all.missingUsageCalls}。欠落分は0トークンとはみなしません。`,
    `取得試行: ${summary.all.retrieval.reads}。取得成功: ${summary.all.retrieval.successfulReads}。取得失敗: ${summary.all.retrieval.readFailures}。取得中止: ${summary.all.retrieval.cancelledReads}。`,
    `10秒以内の回答: ${summary.all.latency.withinTarget}/${summary.all.n}。10秒以内かつ合格: ${summary.all.latency.passedWithinTarget}/${summary.all.n}。`,
    "",
    "応答時間は検索語生成〜回答JSON完了まで（起動・検索・取得を含む）。採点はtotalMsにのみ含みます。",
    "firstMessageEventMsはSDKのメッセージイベント到着時間であり、厳密なTTFTではありません。",
    "判断理由・引用・本文・失敗の詳細は各試行のJSONを参照してください。",
    "",
  ];
  await writeFile(join(dir, "report.md"), lines.join("\n"), { mode: 0o600 });
  return summary;
}
