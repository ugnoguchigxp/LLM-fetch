import { execFile } from "node:child_process";
import { brave, duckDuckGo } from "../dist/index.js";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = new URL("../", import.meta.url);

const requestedMode = process.argv[2] ?? "duckduckgo";

async function readGitState() {
  const [{ stdout: commit }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
    }),
    execFileAsync("git", ["status", "--porcelain=v1"], {
      cwd: projectRoot,
      encoding: "utf8",
    }),
  ]);
  return {
    commit: commit.trim(),
    clean: status.trim().length === 0,
  };
}

async function writeEvidence(mode, result) {
  const evidence = {
    ...result,
    checkedAt: new Date().toISOString(),
    git: await readGitState(),
  };
  await mkdir(new URL("../.release-evidence/", import.meta.url), {
    recursive: true,
  });
  await writeFile(
    new URL(
      `../.release-evidence/provider-canary-${mode}.json`,
      import.meta.url,
    ),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { mode: 0o600 },
  );
  return evidence;
}

async function runCanary() {
  if (requestedMode !== "duckduckgo" && requestedMode !== "brave") {
    throw new Error("Unknown provider canary mode.");
  }
  if (
    requestedMode === "brave" &&
    !process.env.BRAVE_SEARCH_API_KEY?.trim()
  ) {
    throw new Error("The Brave provider canary is not configured.");
  }
  const provider =
    requestedMode === "brave"
      ? brave({ apiKey: process.env.BRAVE_SEARCH_API_KEY ?? "" })
      : duckDuckGo({ timeoutMs: 10_000 });
  const hits = await provider.search({
    query: "site:example.com Example Domain",
    limit: 3,
    safeSearch: "strict",
    language: "en",
    region: "US",
  });
  if (hits.length === 0) {
    throw new Error(`${provider.name} canary returned no results.`);
  }
  const result = await writeEvidence(requestedMode, {
    provider: provider.name,
    status: "passed",
    resultCount: hits.length,
  });
  process.stdout.write(
    `${JSON.stringify({ provider: result.provider, resultCount: result.resultCount })}\n`,
  );
}

try {
  await runCanary();
} catch (error) {
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.code)
      ? error.code
      : "CANARY_FAILED";
  const provider =
    requestedMode === "brave"
      ? "brave"
      : requestedMode === "duckduckgo"
        ? "duckduckgo"
        : "unknown";
  if (provider !== "unknown") {
    try {
      await writeEvidence(requestedMode, {
        provider,
        status: "failed",
        code,
      });
    } catch {
      // The sanitized stderr result remains available if evidence I/O fails.
    }
  }
  process.stderr.write(
    `${JSON.stringify({ provider, status: "failed", code })}\n`,
  );
  process.exitCode = 1;
}
