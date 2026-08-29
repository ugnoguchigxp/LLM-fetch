import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
const tag = process.argv[2];

if (typeof tag !== "string" || !tag) {
  throw new Error("A release tag is required.");
}
if (tag !== `v${manifest.version}`) {
  throw new Error(
    `Release tag ${tag} does not match package version v${manifest.version}.`,
  );
}

process.stdout.write(`Release tag ${tag} matches package.json.\n`);
