import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
      new URL("coverage/benchmark-summary.json", projectRoot),
      "utf8",
    ),
  );
} catch {
  benchmark = null;
}

process.stdout.write(
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      node: process.version,
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
    },
    null,
    2,
  )}\n`,
);
