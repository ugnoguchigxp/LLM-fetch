import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createBuiltinContextGuard } from "../dist/index.js";
import {
  attackCorpus,
  benignCorpus,
} from "../test/fixtures/context-guard-corpus.js";

const outputUrl = new URL(
  "../crates/tauri-plugin-llm-fetch/tests/fixtures/security/ts-guard-v1.json",
  import.meta.url,
);
const source = { kind: "web", trust: "untrusted" };

async function generate() {
  const guard = createBuiltinContextGuard();
  const fixtures = [...attackCorpus, ...benignCorpus]
    .filter((fixture) => (fixture.contentType ?? "text/plain").startsWith("text/plain"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const cases = [];
  for (const fixture of fixtures) {
    const requestedUse = fixture.requestedUse ?? "answer_with_citation";
    const result = await guard.inspectRaw({
      rawBody: new TextEncoder().encode(fixture.body),
      contentType: "text/plain; charset=utf-8",
      source,
      requestedUse,
    });
    cases.push({
      name: fixture.name,
      text: fixture.body,
      requestedUse,
      expected: {
        findings: result.findings.map((finding) => ({
          category: finding.category,
          severity: finding.severity,
          confidence: finding.confidence,
          location: finding.location,
          techniques: finding.techniques,
          segmentHash: finding.segmentHash,
        })),
        decision: result.decision,
        reasons: result.reasons,
      },
    });
  }
  return `${JSON.stringify({ schemaVersion: 1, profile: "balanced", cases }, null, 2)}\n`;
}

const generated = await generate();
if (process.argv.includes("--check")) {
  const committed = await readFile(outputUrl, "utf8").catch(() => "");
  if (committed !== generated) {
    throw new Error(
      `Rust guard fixture is stale. Run node ${fileURLToPath(import.meta.url)}.`,
    );
  }
} else {
  await writeFile(outputUrl, generated);
}
