import { describe, expect, it } from "vitest";
import { LlmFetchError, toLlmFetchError } from "../src/errors.js";

describe("structured errors", () => {
  it("serializes only the documented safe fields", () => {
    const cause = new Error("raw secret body");
    const error = new LlmFetchError("GUARD_DENIED", "withheld", {
      cause,
      provider: "fixture",
      url: "https://example.com/",
      status: 403,
      retryable: false,
      cooldownMs: 1_000,
      guardDecision: "require_approval",
      warningCategories: ["hidden_instruction", "hidden_instruction"],
    });
    expect(error.toJSON()).toEqual({
      name: "LlmFetchError",
      code: "GUARD_DENIED",
      message: "withheld",
      retryable: false,
      provider: "fixture",
      url: "https://example.com/",
      status: 403,
      cooldownMs: 1_000,
      guardDecision: "require_approval",
      warningCategories: ["hidden_instruction"],
    });
    expect(JSON.stringify(error)).not.toContain("raw secret body");
  });

  it("wraps unknown errors with optional provider and URL context", () => {
    expect(
      toLlmFetchError(new Error("raw"), {
        code: "UPSTREAM_HTTP",
        message: "safe",
        provider: "fixture",
        url: "https://example.com/",
        retryable: true,
      }),
    ).toMatchObject({
      code: "UPSTREAM_HTTP",
      message: "safe",
      provider: "fixture",
      url: "https://example.com/",
      retryable: true,
    });
  });

  it("omits absent optional fields from JSON", () => {
    expect(new LlmFetchError("UNKNOWN", "safe").toJSON()).toEqual({
      name: "LlmFetchError",
      code: "UNKNOWN",
      message: "safe",
      retryable: false,
    });
  });
});
