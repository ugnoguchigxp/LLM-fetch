import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "playwright/index": "src/playwright/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: false,
  minify: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: "node22",
  external: ["playwright-core"],
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
