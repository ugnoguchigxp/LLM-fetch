import { describe, expect, it } from "vitest";
import type { SearchProvider } from "../../src/contracts.js";
import { custom } from "../../src/providers/custom.js";

describe("custom provider", () => {
  it("preserves a valid provider", () => {
    const provider: SearchProvider = {
      name: "fixture",
      async search() {
        return [];
      },
    };
    expect(custom(provider)).toBe(provider);
  });

  it.each([
    null,
    {},
    { name: "", search: async () => [] },
    { name: "x\nheader", search: async () => [] },
    { name: "x".repeat(101), search: async () => [] },
    { name: "fixture" },
  ])("rejects an invalid provider: %o", (provider) => {
    expect(() => custom(provider as never)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });
});
