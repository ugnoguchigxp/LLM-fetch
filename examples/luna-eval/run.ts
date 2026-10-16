import { parseArgs } from "node:util";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createModel, errorMessage } from "./model.ts";
import { runScenario } from "./pipeline.ts";
import type { Result, Settings } from "./pipeline.ts";
import { diverseScenarios } from "./diverse.ts";
import { scenarios, validateScenarios } from "./scenarios.ts";
import { writeReport } from "./report.ts";

const base = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    list: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    suite: { type: "string", default: "all" },
    ids: { type: "string" },
    limit: { type: "string" },
    repeat: { type: "string", default: "1" },
    provider: { type: "string", default: process.env.EVAL_PROVIDER ?? "brave" },
    model: { type: "string", default: process.env.LUNA_MODEL ?? "gpt-6-luna" },
    "judge-model": { type: "string", default: process.env.LUNA_JUDGE_MODEL ?? "gpt-6-luna" },
    "service-tier": { type: "string", default: process.env.LUNA_SERVICE_TIER ?? "standard" },
    strategy: { type: "string", default: "paired" },
    "timeout-ms": { type: "string", default: "120000" },
    "scenario-timeout-ms": { type: "string", default: "600000" },
    scenarios: { type: "string" },
    out: { type: "string" },
  },
});
function integer(value: string | undefined, name: string, max: number) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`Invalid ${name}: 1..${max}`);
  return n;
}
async function main() {
  const source = values.scenarios
    ? JSON.parse(await readFile(resolve(values.scenarios), "utf8"))
    : values.suite === "expanded"
      ? [...scenarios, ...diverseScenarios]
      : values.suite === "diverse"
        ? diverseScenarios
        : scenarios;
  const all = validateScenarios(source);
  if (!["all", "live", "fixture", "expanded", "diverse"].includes(values.suite))
    throw new Error("Unknown suite");
  if (!["brave", "duckduckgo"].includes(values.provider)) throw new Error("Unknown provider");
  if (!["standard", "fast"].includes(values["service-tier"]))
    throw new Error("Unknown service tier");
  if (!["staged", "search-and-read", "adaptive", "paired"].includes(values.strategy))
    throw new Error("Unknown strategy");
  const ids = values.ids?.split(",");
  if (ids?.some((id) => !all.some((s) => s.id === id))) throw new Error("Unknown scenario id");
  let selected = all.filter(
    (s) =>
      (["all", "expanded", "diverse"].includes(values.suite) || s.mode === values.suite) &&
      (!ids || ids.includes(s.id)),
  );
  if (values.limit) selected = selected.slice(0, integer(values.limit, "limit", all.length));
  if (!selected.length) throw new Error("No scenarios selected");
  const repeat = integer(values.repeat, "repeat", 100);
  const timeoutMs = integer(values["timeout-ms"], "timeout-ms", 3_600_000);
  const settings: Settings = {
    strategy: values.strategy as NonNullable<Settings["strategy"]>,
    provider: values.provider as Settings["provider"],
    scenarioTimeoutMs: integer(values["scenario-timeout-ms"], "scenario-timeout-ms", 7_200_000),
  };
  if (values.list || values["dry-run"]) {
    console.log(
      JSON.stringify(
        {
          model: values.model,
          judgeModel: values["judge-model"],
          provider: settings.provider,
          repeat,
          planned: selected.length * repeat,
          scenarios: selected.map(({ id, mode, category, request }) => ({
            id,
            mode,
            category,
            request,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (
    selected.some((s) => s.mode === "live") &&
    settings.provider === "brave" &&
    !process.env.BRAVE_SEARCH_API_KEY?.trim()
  ) {
    throw new Error(
      "BRAVE_SEARCH_API_KEY is required for live Brave scenarios. Use --suite fixture for controlled scenarios.",
    );
  }
  const dir = resolve(
    values.out ??
      join(
        base,
        "results",
        `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`,
      ),
  );
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Refuse to overwrite evidence from a previous run.
  const manifestPath = join(dir, "manifest.json");
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const files = [
    "contracts.ts",
    "prompts.ts",
    "model-instructions.txt",
    "model.ts",
    "pipeline.ts",
    "adaptive.ts",
    "paired.ts",
    "fixtures.ts",
    "scenarios.ts",
    "diverse.ts",
    "report.ts",
    "compare.ts",
    "run.ts",
    "package-lock.json",
  ];
  const hashes = Object.fromEntries(
    await Promise.all(files.map(async (f) => [f, hash(await readFile(join(base, f), "utf8"))])),
  );
  let git: unknown = null;
  try {
    git = {
      commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: base, encoding: "utf8" }).trim(),
      dirty:
        execFileSync("git", ["status", "--porcelain"], { cwd: base, encoding: "utf8" }).trim()
          .length > 0,
    };
  } catch {
    /* Non-Git installations still run. */
  }
  const library = await readFile(join(base, "../../dist/index.js"), "utf8");
  const manifest = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    node: process.version,
    model: values.model,
    judgeModel: values["judge-model"],
    reasoningEffort: "low",
    serviceTier: values["service-tier"],
    transport: "https-sse",
    researchConversation:
      settings.strategy === "paired"
        ? "self-contained-assessments; guards-and-judge-isolated"
        : "one-per-scenario; guards-and-judge-isolated",
    evaluationPolicy: settings.strategy === "paired" ? "goal-v1" : "dimensions-v1",
    latencyTargetMs: 10_000,
    settings,
    modelTimeoutMs: timeoutMs,
    repeat,
    planned: selected.length * repeat,
    git,
    hashes,
    librarySha256: hash(library),
    scenariosSha256: hash(JSON.stringify(selected)),
    scenarios: selected,
    sdkVersion: JSON.parse(
      await readFile(join(base, "node_modules/@openai/codex-sdk/package.json"), "utf8"),
    ).version,
    codexPath: process.env.CODEX_PATH ?? "SDK bundled runtime",
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Interrupted"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const runtime = await createModel(
    values.model,
    values["judge-model"],
    timeoutMs,
    values["service-tier"] as "standard" | "fast",
  );
  const results: Result[] = [];
  console.log(`Results: ${dir}`);
  let previousError: string | null = null;
  let sameErrors = 0;
  try {
    outer: for (let attempt = 1; attempt <= repeat; attempt++) {
      for (const scenario of selected) {
        if (controller.signal.aborted) break outer;
        const result = await runScenario(
          scenario,
          attempt,
          runtime.model,
          settings,
          controller.signal,
        );
        results.push(result);
        await writeFile(
          join(dir, `${scenario.id}.${attempt}.json`),
          JSON.stringify(result, null, 2),
          { flag: "wx", mode: 0o600 },
        );
        await appendFile(join(dir, "results.jsonl"), JSON.stringify(result) + "\n", {
          mode: 0o600,
        });
        await writeReport(dir, results, manifest.planned);
        console.log(
          `[${results.length}/${manifest.planned}] ${scenario.id} #${attempt}: ${result.status} (${Math.round(result.pipelineMs)} ms)${result.failedStage ? ` stage=${result.failedStage}` : ""}`,
        );
        const signature = result.error;
        sameErrors = signature && signature === previousError ? sameErrors + 1 : signature ? 1 : 0;
        previousError = signature;
        if (sameErrors >= 3) {
          console.error(
            "Stopped after three identical execution errors. Inspect saved evidence before retrying.",
          );
          break outer;
        }
      }
    }
  } finally {
    await writeReport(dir, results, manifest.planned);
    await runtime.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  if (results.length !== manifest.planned || results.some((r) => r.status !== "passed"))
    process.exitCode = 1;
}
main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
