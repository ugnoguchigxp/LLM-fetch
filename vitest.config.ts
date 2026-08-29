import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      // The optional browser subpath is exercised by the isolated Chromium job;
      // including it in core coverage would turn environment skips into false gaps.
      exclude: ["src/playwright/**"],
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 85,
      },
    },
    benchmark: {
      include: ["bench/**/*.bench.ts"],
    },
  },
});
