import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, "..");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "llm-fetch-package-"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const packageManifest = JSON.parse(
  await readFile(join(projectRoot, "package.json"), "utf8"),
);
const packageSpecifier = JSON.stringify(packageManifest.name);
const playwrightSpecifier = JSON.stringify(
  `${packageManifest.name}/playwright`,
);

async function run(command, arguments_, cwd = projectRoot) {
  return execFileAsync(command, arguments_, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

try {
  const packed = await run(npmCommand, [
    "pack",
    "--json",
    "--pack-destination",
    temporaryDirectory,
  ]);
  const jsonStart = packed.stdout.lastIndexOf("\n[");
  const packResult = JSON.parse(
    jsonStart >= 0 ? packed.stdout.slice(jsonStart + 1) : packed.stdout,
  );
  const packedMetadata = packResult?.[0];
  const filename = packedMetadata?.filename;
  if (typeof filename !== "string" || !filename) {
    throw new Error("npm pack did not report a tarball filename.");
  }
  if (
    packedMetadata.name !== packageManifest.name ||
    packedMetadata.version !== packageManifest.version
  ) {
    throw new Error("npm pack metadata does not match package.json.");
  }
  const packedPaths = new Set(
    (packedMetadata.files ?? []).map((entry) => entry.path),
  );
  for (const requiredPath of [
    "LICENSE",
    "NOTICE",
    "README.md",
    "README.ja.md",
    "CHANGELOG.md",
    "SECURITY.md",
    "package.json",
  ]) {
    if (!packedPaths.has(requiredPath)) {
      throw new Error(`Packed package is missing ${requiredPath}.`);
    }
  }
  const tarball = join(temporaryDirectory, filename);
  await writeFile(
    join(temporaryDirectory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await run(
    npmCommand,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    temporaryDirectory,
  );

  const installedPackageRoot = join(
    temporaryDirectory,
    "node_modules",
    ...packageManifest.name.split("/"),
  );
  const installedPackage = JSON.parse(
    await readFile(join(installedPackageRoot, "package.json"), "utf8"),
  );
  if (installedPackage.license !== "MIT") {
    throw new Error("The packed package does not declare the MIT license.");
  }
  await Promise.all([
    access(join(installedPackageRoot, "LICENSE")),
    access(join(installedPackageRoot, "NOTICE")),
    access(join(installedPackageRoot, "README.md")),
    access(join(installedPackageRoot, "README.ja.md")),
    access(join(installedPackageRoot, "CHANGELOG.md")),
    access(join(installedPackageRoot, "SECURITY.md")),
  ]);

  try {
    await access(join(temporaryDirectory, "node_modules", "playwright-core"));
    throw new Error(
      "A core-only install unexpectedly included playwright-core.",
    );
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
  }

  const esmConsumer = `
    import { createLlmFetch } from ${packageSpecifier};
    import { playwrightRetriever } from ${playwrightSpecifier};
    const client = createLlmFetch({
      search: { name: "fixture", async search() { return []; } },
    });
    const retriever = playwrightRetriever();
    if (await retriever.isAvailable() !== false) throw new Error("unexpected browser runtime");
    await retriever.close();
    await client.close();
  `;
  const cjsConsumer = `
    const { createLlmFetch } = require(${packageSpecifier});
    const { playwrightRetriever } = require(${playwrightSpecifier});
    (async () => {
      const client = createLlmFetch({
        search: { name: "fixture", async search() { return []; } },
      });
      const retriever = playwrightRetriever();
      if (await retriever.isAvailable() !== false) throw new Error("unexpected browser runtime");
      await retriever.close();
      await client.close();
    })().catch((error) => {
      process.nextTick(() => { throw error; });
    });
  `;
  const typeConsumer = `
    import { createLlmFetch, type SearchProvider } from ${packageSpecifier};
    import { playwrightRetriever } from ${playwrightSpecifier};
    const search: SearchProvider = { name: "fixture", async search() { return []; } };
    const browser = playwrightRetriever();
    const client = createLlmFetch({ search, browser: { retriever: browser } });
    void client.close();
  `;
  await Promise.all([
    writeFile(join(temporaryDirectory, "consumer.mjs"), esmConsumer),
    writeFile(join(temporaryDirectory, "consumer.cjs"), cjsConsumer),
    writeFile(join(temporaryDirectory, "consumer.ts"), typeConsumer),
    writeFile(
      join(temporaryDirectory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          skipLibCheck: false,
          noEmit: true,
        },
        files: ["consumer.ts"],
      }),
    ),
    writeFile(
      join(temporaryDirectory, "tsconfig.bundler.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          skipLibCheck: false,
          noEmit: true,
        },
        files: ["consumer.ts"],
      }),
    ),
  ]);

  await run(process.execPath, [join(temporaryDirectory, "consumer.mjs")]);
  await run(process.execPath, [join(temporaryDirectory, "consumer.cjs")]);
  const typescriptPackage = JSON.parse(
    await readFile(
      join(projectRoot, "node_modules", "typescript", "package.json"),
      "utf8",
    ),
  );
  await run(process.execPath, [
    join(projectRoot, "node_modules", "typescript", typescriptPackage.bin.tsc),
    "--project",
    join(temporaryDirectory, "tsconfig.json"),
  ]);
  await run(process.execPath, [
    join(projectRoot, "node_modules", "typescript", typescriptPackage.bin.tsc),
    "--project",
    join(temporaryDirectory, "tsconfig.bundler.json"),
  ]);

  process.stdout.write(
    "Packed ESM, CommonJS, types, and core-only install verified.\n",
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
