import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createGuardCorpusReport } from "./guard-corpus-report.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = new URL("../", import.meta.url);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const manifest = JSON.parse(
  await readFile(new URL("package.json", projectRoot), "utf8"),
);
const packed = await execFileAsync(
  npmCommand,
  ["pack", "--dry-run", "--json"],
  { cwd: projectRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
);
const jsonStart = packed.stdout.lastIndexOf("\n[");
const pack = JSON.parse(
  jsonStart >= 0 ? packed.stdout.slice(jsonStart + 1) : packed.stdout,
)?.[0];

const vitestManifest = JSON.parse(
  await readFile(
    new URL("node_modules/vitest/package.json", projectRoot),
    "utf8",
  ),
);
const vitestBin = vitestManifest.bin?.vitest;
if (typeof vitestBin !== "string" || !vitestBin) {
  throw new Error("Vitest executable metadata is missing.");
}
const testRun = await execFileAsync(
  process.execPath,
  [
    fileURLToPath(new URL(vitestBin, new URL("node_modules/vitest/", projectRoot))),
    "run",
    "--reporter=json",
    "--silent",
  ],
  { cwd: projectRoot, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
);
const testReport = JSON.parse(testRun.stdout);

const [{ stdout: commit }, { stdout: worktreeStatus }] = await Promise.all([
  execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
  }),
  execFileAsync("git", ["status", "--porcelain=v1"], {
    cwd: projectRoot,
    encoding: "utf8",
  }),
]);
const currentCommit = commit.trim();
const clean = worktreeStatus.trim().length === 0;

let coverage;
try {
  coverage = JSON.parse(
    await readFile(new URL("coverage/coverage-summary.json", projectRoot), "utf8"),
  ).total;
} catch {
  coverage = null;
}

let benchmark;
try {
  benchmark = JSON.parse(
    await readFile(
      new URL(".release-evidence/benchmark-summary.json", projectRoot),
      "utf8",
    ),
  );
  if (benchmark.git?.commit !== currentCommit || benchmark.git?.clean !== true) {
    benchmark = null;
  }
} catch {
  benchmark = null;
}

const guardCorpus = await createGuardCorpusReport();
const canaries = {};
for (const provider of ["duckduckgo", "brave"]) {
  try {
    const canary = JSON.parse(
      await readFile(
        new URL(
          `.release-evidence/provider-canary-${provider}.json`,
          projectRoot,
        ),
        "utf8",
      ),
    );
    const matchesCommit =
      canary.provider === provider &&
      typeof canary.checkedAt === "string" &&
      canary.git?.commit === currentCommit &&
      canary.git?.clean === true;
    const passed =
      (canary.status === "passed" || canary.status === undefined) &&
      Number.isInteger(canary.resultCount) &&
      canary.resultCount > 0;
    const failed =
      canary.status === "failed" &&
      typeof canary.code === "string" &&
      /^[A-Z][A-Z0-9_]{1,63}$/u.test(canary.code);
    if (matchesCommit && (passed || failed)) canaries[provider] = canary;
  } catch {
    // Provider canaries are explicit release actions and may not have run yet.
  }
}
process.stdout.write(
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      node: process.version,
      git: {
        commit: currentCommit,
        clean,
      },
      package: {
        name: manifest.name,
        version: manifest.version,
        private: manifest.private === true,
        packedBytes: pack?.size,
        unpackedBytes: pack?.unpackedSize,
        fileCount: pack?.entryCount,
      },
      tests: {
        success: testReport.success === true,
        total: testReport.numTotalTests,
        passed: testReport.numPassedTests,
        failed: testReport.numFailedTests,
        skipped: testReport.numPendingTests,
      },
      coverage,
      benchmark,
      guardCorpus,
      providerCanaries: canaries,
    },
    null,
    2,
  )}\n`,
);
