import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const packageManifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const expected = /^npm@(\d+)\.(\d+)\.(\d+)$/u.exec(
  packageManifest.packageManager ?? "",
);
if (!expected) {
  throw new Error("package.json must pin packageManager to an exact npm version.");
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const actualVersion = execFileSync(npmCommand, ["--version"], {
  encoding: "utf8",
  shell: process.platform === "win32",
}).trim();
const actual = /^(\d+)\.(\d+)\.(\d+)$/u.exec(actualVersion);
if (!actual) throw new Error(`Could not parse npm version: ${actualVersion}`);

const expectedVersion = expected.slice(1).map(Number);
const actualParts = actual.slice(1).map(Number);
const compare = (left, right) => {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};
if (compare(actualParts, expectedVersion) !== 0) {
  throw new Error(
    `npm ${actualVersion} does not match packageManager npm@${expectedVersion.join(".")}.`,
  );
}

process.stdout.write(`npm ${actualVersion} matches packageManager.\n`);
