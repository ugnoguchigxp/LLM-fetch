import assert from "node:assert/strict";
import { test } from "node:test";
import { auditAvailability, auditInput, validateAudit } from "../audit.ts";
import type { Result } from "../pipeline.ts";

await test("diagnostic input contains only actually returned Markdown and preserves the primary result", () => {
  const r = {
    request: "Compare facts",
    trace: [
      {
        name: "fetch_content",
        input: {},
        error: null,
        result: {
          type: "fetch_content_result",
          document: {
            url: "https://example.com/",
            text: "First fact\n\nSecond fact",
            fetchedAt: "2026-10-16",
            truncated: false,
          },
          security: {
            trust: "untrusted",
            tainted: true,
            decision: "allow",
            warningCategories: [],
            reasonCodes: [],
          },
        },
      },
      {
        name: "fetch_content",
        input: { url: "https://example.com/denied" },
        error: { code: "GUARD_DENIED", message: "rejected", metadata: null },
        result: null,
      },
    ],
  } satisfies Pick<Result, "request" | "trace">;
  const before = JSON.stringify(r);
  const input = auditInput(r);
  assert.deepEqual(input.sources[0]!.blocks, [
    { id: "d1-b1", text: "First fact" },
    { id: "d1-b2", text: "Second fact" },
  ]);
  assert.equal(input.sources.length, 1);
  assert.ok(!JSON.stringify(input).includes("denied"));
  assert.equal(JSON.stringify(r), before);
  const audit = {
    abstentionAppropriate: false,
    reason: "controlled",
    coverage: [
      {
        requirement: "Fact",
        status: "confirmed" as const,
        sourceBlockIds: ["d1-b1"],
        reason: "controlled",
      },
    ],
  };
  validateAudit(audit, input);
  assert.throws(() =>
    validateAudit(
      { ...audit, coverage: [{ ...audit.coverage[0]!, sourceBlockIds: ["unknown"] }] },
      input,
    ),
  );
  assert.throws(() =>
    validateAudit({ ...audit, coverage: [{ ...audit.coverage[0]!, sourceBlockIds: [] }] }, input),
  );
  assert.equal(auditAvailability(audit), true);
  assert.equal(
    auditAvailability({ ...audit, coverage: [{ ...audit.coverage[0]!, status: "missing" }] }),
    false,
  );
});
