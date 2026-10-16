import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { summarize } from "./report.ts";
import type { Result } from "./pipeline.ts";

async function readRun(dir: string) {
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  const results = (await readFile(join(dir, "results.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Result);
  return { manifest, results };
}
export async function compareRuns(baselineDir: string, candidateDir: string) {
  const [before, after] = await Promise.all([readRun(baselineDir), readRun(candidateDir)]);
  const cohort = (rs: Result[]) =>
    rs
      .map((r) => `${r.scenarioId}:${r.repeat}`)
      .sort()
      .join("\n");
  if (cohort(before.results) !== cohort(after.results))
    throw new Error("Scenario/repeat cohort mismatch");
  const checks = Object.fromEntries(
    ["model", "judgeModel", "serviceTier", "sdkVersion", "scenariosSha256", "librarySha256"].map(
      (k) => [k, before.manifest[k] === after.manifest[k]],
    ),
  );
  checks.evaluationPolicy =
    (before.manifest.evaluationPolicy ?? "dimensions-v1") ===
    (after.manifest.evaluationPolicy ?? "dimensions-v1");
  const hashes = [
    "contracts.ts",
    "prompts.ts",
    "model-instructions.txt",
    "model.ts",
    "pipeline.ts",
    "adaptive.ts",
    "paired.ts",
    "report.ts",
  ].filter((k) => before.manifest.hashes[k] !== after.manifest.hashes[k]);
  const summary = (rs: Result[]) => ({
    all: summarize(rs),
    live: summarize(rs.filter((r) => r.mode === "live")),
    fixture: summarize(rs.filter((r) => r.mode === "fixture")),
  });
  const b = summary(before.results);
  const a = summary(after.results);
  const rows = after.results.map((r) => {
    const old = before.results.find((o) => o.scenarioId === r.scenarioId && o.repeat === r.repeat)!;
    const modelMs = r.measurements
      .filter((m) => m.stage === "query" || m.stage === "answer" || m.stage === "assess")
      .reduce((n, m) => n + m.durationMs, 0);
    return {
      id: r.scenarioId,
      mode: r.mode,
      before: old.status,
      after: r.status,
      oldReads: summarize([old]).retrieval.reads,
      reads: summarize([r]).retrieval.reads,
      successfulReads: summarize([r]).retrieval.successfulReads,
      cancelled: summarize([r]).retrieval.cancelledReads,
      oldMs: old.pipelineMs,
      ms: r.pipelineMs,
      modelMs,
      retrievalWaitMs: Math.max(0, r.pipelineMs - modelMs),
      queryMs: r.measurements
        .filter((m) => m.stage === "query")
        .reduce((n, m) => n + m.durationMs, 0),
      answerCalls: r.measurements.filter((m) => m.stage === "answer" || m.stage === "assess")
        .length,
      guardCalls: r.measurements
        .filter((m) => m.stage === "guard")
        .map((m) => ({ ms: m.durationMs, decision: m.guardDecision, error: m.error })),
      tokens: summarize([r]).tokens.all,
      failedStage: r.failedStage,
      error: r.error,
      contractFailures: r.contractFailures,
      stopReason: r.paired?.stopReason ?? r.research?.stopReason,
      deficits: r.judgment
        ? Object.fromEntries(
            Object.entries(r.judgment).filter(
              ([k, v]) => k !== "criteria" && "score" in v && v.score < 3,
            ),
          )
        : {},
      criteria: r.judgment?.criteria.filter((c) => c.result !== "pass"),
      retrievalErrors: r.trace
        .filter((t) => t.error)
        .map((t) => ({
          url: t.input.url,
          query: t.input.query,
          error: t.error,
          cancellation: t.cancellation,
        })),
    };
  });
  const comparison = {
    baseline: resolve(baselineDir),
    candidate: resolve(candidateDir),
    checks,
    changedFiles: hashes,
    before: b,
    after: a,
    modelAloneOver10Seconds: rows.filter((r) => r.modelMs > 10000).length,
    rows,
  };
  await writeFile(join(candidateDir, "comparison.json"), JSON.stringify(comparison, null, 2), {
    mode: 0o600,
  });
  const fmt = (n: number | null) => (n === null ? "—" : n.toFixed(2));
  const lines = [
    "# 少数資料・非同期取得の比較",
    "",
    `基準: ${resolve(baselineDir)}`,
    `今回: ${resolve(candidateDir)}`,
    "",
    ...(checks.evaluationPolicy
      ? []
      : ["注意: 評価版が異なるため、合格率の増減を実装品質の改善/悪化として比較できません。", ""]),
    "同一シナリオ・反復集合で比較。本文取得数は成功・失敗・中止を含む取得API呼び出し相当数。旧一括APIの未開始結果を含む場合は実HTTP回数とは異なる。",
    `一致条件: ${JSON.stringify(checks)}。変更ファイル: ${hashes.join(", ")}。変更一式の比較であり単一要因の因果比較ではない。`,
    "",
    "| 指標（全20件） | 基準 | 今回 |",
    "|---|---:|---:|",
    `| 合格 | ${b.all.passed}/${b.all.n} | ${a.all.passed}/${a.all.n} |`,
    `| 実サイト合格 | ${b.live.passed}/${b.live.n} | ${a.live.passed}/${a.live.n} |`,
    `| 固定資料合格 | ${b.fixture.passed}/${b.fixture.n} | ${a.fixture.passed}/${a.fixture.n} |`,
    `| 取得対象数 | ${b.all.retrieval.reads} | ${a.all.retrieval.reads} |`,
    `| 取得成功数 | ${b.all.retrieval.successfulReads} | ${a.all.retrieval.successfulReads} |`,
    `| 取得中止数 | ${b.all.retrieval.cancelledReads} | ${a.all.retrieval.cancelledReads} |`,
    `| 研究担当の既知トークン | ${b.all.tokens.researcher.knownTotalTokens} | ${a.all.tokens.researcher.knownTotalTokens} |`,
    `| 採点担当の既知トークン | ${b.all.tokens.judge.knownTotalTokens} | ${a.all.tokens.judge.knownTotalTokens} |`,
    `| 合計既知トークン | ${b.all.tokens.all.knownTotalTokens} | ${a.all.tokens.all.knownTotalTokens} |`,
    `| 使用量欠測呼び出し | ${b.all.tokens.all.missingUsageCalls} | ${a.all.tokens.all.missingUsageCalls} |`,
    `| 応答中央値（秒） | ${fmt((b.all.pipelineMs.p50 ?? 0) / 1000)} | ${fmt((a.all.pipelineMs.p50 ?? 0) / 1000)} |`,
    `| 応答p95（秒） | ${fmt((b.all.pipelineMs.p95 ?? 0) / 1000)} | ${fmt((a.all.pipelineMs.p95 ?? 0) / 1000)} |`,
    `| 10秒以内の回答 | ${b.all.latency.withinTarget}/${b.all.n} | ${a.all.latency.withinTarget}/${a.all.n} |`,
    `| 10秒以内かつ合格 | ${b.all.latency.passedWithinTarget}/${b.all.n} | ${a.all.latency.passedWithinTarget}/${a.all.n} |`,
    "",
    `計画＋回答の直列モデル呼び出しだけで10秒を超えた試行: ${comparison.modelAloneOver10Seconds}/${a.all.n}。Guard呼び出しはこの値に含まない。`,
    "",
    "| シナリオ | 基準→今回 | 取得数 基準→今回 | 応答秒 基準→今回 | 計画＋回答 秒 |",
    "|---|---|---:|---:|---:|",
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.before} → ${r.after} | ${r.oldReads} → ${r.reads} | ${fmt(r.oldMs / 1000)} → ${fmt(r.ms / 1000)} | ${fmt(r.modelMs / 1000)} |`,
    ),
    "",
    "使用量欠測分は0と扱わない。応答時間は回答完了までで独立採点を含まない。Guard時間は取得や回答と重なるため単純加算しない。",
    "",
    ...rows
      .filter((r) => r.after !== "passed")
      .flatMap((r) => [
        `## ${r.id}`,
        `状態: ${r.after}。失敗段階: ${r.failedStage ?? "採点上の不合格"}。`,
        "```json",
        JSON.stringify(
          {
            deficits: r.deficits,
            criteria: r.criteria,
            retrievalErrors: r.retrievalErrors,
            guardCalls: r.guardCalls,
            contractFailures: r.contractFailures,
            error: r.error,
          },
          null,
          2,
        ),
        "```",
        "",
      ]),
  ];
  await writeFile(join(candidateDir, "comparison.md"), lines.join("\n"), { mode: 0o600 });
  return comparison;
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({
    options: { baseline: { type: "string" }, candidate: { type: "string" } },
  });
  if (!values.baseline || !values.candidate)
    throw new Error("--baseline and --candidate are required");
  const c = await compareRuns(resolve(values.baseline), resolve(values.candidate));
  console.log(
    JSON.stringify(
      {
        checks: c.checks,
        before: c.before.all,
        after: c.after.all,
        modelAloneOver10Seconds: c.modelAloneOver10Seconds,
      },
      null,
      2,
    ),
  );
}
