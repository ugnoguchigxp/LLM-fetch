import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

const packageVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "playwright/index": "src/playwright/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  minify: true,
  clean: true,
  treeshake: true,
  target: "node20",
  deps: {
    neverBundle: ["playwright-core"],
  },
  define: {
    __LLM_FETCH_VERSION__: JSON.stringify(packageVersion),
  },
  outExtensions({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
