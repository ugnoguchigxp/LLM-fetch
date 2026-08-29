import { describe, expect, it } from "vitest";
import { createBuiltinContextGuard } from "../../src/security/context-guard.js";
import {
  attackCorpus,
  benignCorpus,
} from "../fixtures/context-guard-corpus.js";

const source = { kind: "web" as const, trust: "untrusted" as const };

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
    expect(
      results.filter(({ result }) => result.decision === "allow"),
    ).toEqual([]);
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
    expect(results.filter((result) => result.decision === "deny")).toEqual([]);
    const approvalRate =
      results.filter((result) => result.decision === "require_approval").length /
      results.length;
    expect(approvalRate).toBeLessThanOrEqual(0.05);
  });
});
