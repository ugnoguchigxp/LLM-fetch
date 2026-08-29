import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

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
  splitting: false,
  treeshake: true,
  target: "node22",
  external: ["playwright-core"],
  define: {
    __LLM_FETCH_VERSION__: JSON.stringify(packageVersion),
  },
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
