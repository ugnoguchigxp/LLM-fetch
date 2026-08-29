import { describe, expect, it } from "vitest";
import { createBuiltinContextGuard } from "../../src/security/context-guard.js";
import {
  attackCorpus,
  benignCorpus,
} from "../fixtures/context-guard-corpus.js";

const source = { kind: "web" as const, trust: "untrusted" as const };
const decisionOrder = {
  allow: 0,
  allow_with_warning: 1,
  require_approval: 2,
  deny: 3,
} as const;

describe("Context Guard release corpus", () => {
  it("allows no high-risk attack fixtures", async () => {
    const guard = createBuiltinContextGuard();
    const results = await Promise.all(
      attackCorpus.map(async (fixture) => ({
        fixture,
        result: await guard.inspectRaw({
          rawBody: new TextEncoder().encode(fixture.body),
          contentType: fixture.contentType ?? "text/plain; charset=utf-8",
          source,
          requestedUse: fixture.requestedUse ?? "answer_with_citation",
        }),
      })),
    );
    for (const { fixture, result } of results) {
      const minimum = fixture.minimumDecision ?? "allow_with_warning";
      expect(decisionOrder[result.decision], fixture.name).toBeGreaterThanOrEqual(
        decisionOrder[minimum],
      );
      expect(
        result.findings.some(
          (finding) => finding.category === fixture.expectedFindingCategory,
        ),
        `${fixture.name}: ${fixture.expectedFindingCategory}`,
      ).toBe(true);
    }
    expect(attackCorpus.length).toBeGreaterThanOrEqual(100);
    expect(new Set(attackCorpus.map((fixture) => fixture.seedName)).size).toBeGreaterThanOrEqual(30);
  });

  it("keeps benign denial and approval rates within the release gate", async () => {
    const guard = createBuiltinContextGuard();
    const results = await Promise.all(
      benignCorpus.map((fixture) =>
        guard.inspectRaw({
          rawBody: new TextEncoder().encode(fixture.body),
          contentType: fixture.contentType ?? "text/plain; charset=utf-8",
          source,
          requestedUse: fixture.requestedUse ?? "answer_with_citation",
        }),
      ),
    );
    for (const [index, result] of results.entries()) {
      const fixture = benignCorpus[index];
      expect(
        fixture?.allowedDecisions?.includes(result.decision),
        fixture?.name,
      ).toBe(true);
    }
    expect(benignCorpus.length).toBeGreaterThanOrEqual(100);
    expect(new Set(benignCorpus.map((fixture) => fixture.seedName)).size).toBeGreaterThanOrEqual(25);
    const approvalRate =
      results.filter((result) => result.decision === "require_approval").length /
      results.length;
    expect(approvalRate).toBeLessThanOrEqual(0.05);
  });
});
