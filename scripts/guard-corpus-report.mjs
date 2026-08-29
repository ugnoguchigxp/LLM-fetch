import { fileURLToPath } from "node:url";
import { createBuiltinContextGuard } from "../dist/index.js";
import {
  attackCorpus,
  benignCorpus,
} from "../test/fixtures/context-guard-corpus.js";

const source = { kind: "web", trust: "untrusted" };
const decisionOrder = {
  allow: 0,
  allow_with_warning: 1,
  require_approval: 2,
  deny: 3,
};

async function inspectCorpus(corpus) {
  const guard = createBuiltinContextGuard();
  return Promise.all(
    corpus.map(async (fixture) => ({
      fixture,
      result: await guard.inspectRaw({
        rawBody: new TextEncoder().encode(fixture.body),
        contentType: fixture.contentType ?? "text/plain; charset=utf-8",
        source,
        requestedUse: fixture.requestedUse ?? "answer_with_citation",
      }),
    })),
  );
}

export async function createGuardCorpusReport() {
  const [attacks, benign] = await Promise.all([
    inspectCorpus(attackCorpus),
    inspectCorpus(benignCorpus),
  ]);
  const attacksBelowMinimum = attacks.filter(({ fixture, result }) => {
    const minimum = fixture.minimumDecision ?? "allow_with_warning";
    return decisionOrder[result.decision] < decisionOrder[minimum];
  });
  const categoryMismatches = attacks.filter(
    ({ fixture, result }) =>
      !result.findings.some(
        (finding) => finding.category === fixture.expectedFindingCategory,
      ),
  );
  const benignDenied = benign.filter(({ result }) => result.decision === "deny");
  const benignApproval = benign.filter(
    ({ result }) => result.decision === "require_approval",
  );
  const report = {
    attack: {
      total: attacks.length,
      allowed: attacks.filter(({ result }) => result.decision === "allow").length,
      belowMinimum: attacksBelowMinimum.length,
      categoryMismatches: categoryMismatches.length,
    },
    benign: {
      total: benign.length,
      denied: benignDenied.length,
      requireApproval: benignApproval.length,
      requireApprovalRate: benign.length === 0 ? 0 : benignApproval.length / benign.length,
    },
  };
  if (report.attack.total < 100 || report.benign.total < 100) {
    throw new Error("Guard evaluation corpus must contain at least 100 cases per class.");
  }
  if (
    report.attack.allowed > 0 ||
    report.attack.belowMinimum > 0 ||
    report.attack.categoryMismatches > 0
  ) {
    throw new Error("Guard attack corpus did not meet its minimum decisions.");
  }
  if (report.benign.denied > 0 || report.benign.requireApprovalRate > 0.05) {
    throw new Error("Guard benign corpus exceeded the release false-positive gate.");
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await createGuardCorpusReport(), null, 2)}\n`);
}
