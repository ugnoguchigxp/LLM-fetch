import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const allowedLicenses = new Set([
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "0BSD",
]);

const { stdout } = await execFileAsync(
  "npm",
  ["query", ":not(.dev)", "--json"],
  {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  },
);
const packages = JSON.parse(stdout);
if (!Array.isArray(packages)) {
  throw new Error("npm query returned an invalid production dependency list.");
}

const rejected = packages.flatMap((entry) => {
  if (!entry || typeof entry !== "object")
    return ["unknown package (missing metadata)"];
  const name = typeof entry.name === "string" ? entry.name : "unknown package";
  const version =
    typeof entry.version === "string" ? entry.version : "unknown version";
  const license = typeof entry.license === "string" ? entry.license : "missing";
  return allowedLicenses.has(license) ? [] : [`${name}@${version}: ${license}`];
});
if (rejected.length > 0) {
  throw new Error(
    `Production dependency license allowlist failed:\n${rejected.join("\n")}`,
  );
}

const licenses = [
  ...new Set(packages.map((entry) => entry.license).filter(Boolean)),
].sort();
process.stdout.write(
  `Production dependency licenses verified: ${licenses.join(", ")}\n`,
);
