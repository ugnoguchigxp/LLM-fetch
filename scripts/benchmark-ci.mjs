import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const worker = fileURLToPath(new URL("./benchmark-worker.mjs", import.meta.url));
const runCount = 3;
const runs = [];

for (let index = 0; index < runCount; index += 1) {
  const { stdout } = await execFileAsync(process.execPath, [worker], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  runs.push(JSON.parse(stdout));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

const firstResults = runs[0]?.results ?? [];
const results = firstResults.map((first) => {
  const matching = runs.map((run) =>
    run.results.find((result) => result.name === first.name),
  );
  if (matching.some((result) => !result)) {
    throw new Error(`Benchmark worker omitted ${first.name}.`);
  }
  const p50Runs = matching.map((result) => result.p50Ms);
  const p95Runs = matching.map((result) => result.p95Ms);
  const p99Runs = matching.map((result) => result.p99Ms);
  const overThresholdRuns = p95Runs.filter(
    (value) => value > first.thresholdMs,
  ).length;
  const result = {
    name: first.name,
    processes: runCount,
    samplesPerProcess: first.samples,
    medianP50Ms: median(p50Runs),
    medianP95Ms: median(p95Runs),
    medianP99Ms: median(p99Runs),
    maxP95Ms: Math.max(...p95Runs),
    thresholdMs: first.thresholdMs,
    overThresholdRuns,
    batchSize: first.batchSize,
  };
  if (
    result.medianP95Ms > result.thresholdMs ||
    result.overThresholdRuns >= Math.ceil(runCount / 2)
  ) {
    throw new Error(
      `${result.name} median p95 ${result.medianP95Ms.toFixed(2)}ms exceeded ${result.thresholdMs}ms in ${result.overThresholdRuns}/${runCount} processes.`,
    );
  }
  return result;
});

const summary = {
  node: process.version,
  strategy: "median of three isolated sequential processes",
  results,
};
const coverageDirectory = new URL("../coverage/", import.meta.url);
await mkdir(coverageDirectory, { recursive: true });
await writeFile(
  new URL("benchmark-summary.json", coverageDirectory),
  `${JSON.stringify(summary, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
