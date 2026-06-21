// Print the CHANGELOG.md section for a given version, used as GitHub Release notes.
// Usage: node scripts/changelog-extract.mjs 0.1.0
// Matches `## [0.1.0]` (optionally followed by a date) up to the next `## ` header.
// Falls back to a generic line if no matching section exists.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!version) {
  console.error("usage: changelog-extract.mjs <version>");
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const md = await readFile(resolve(root, "CHANGELOG.md"), "utf8");
const lines = md.split("\n");

const headerRe = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`);
let start = -1;
for (let i = 0; i < lines.length; i++) {
  if (headerRe.test(lines[i])) {
    start = i + 1;
    break;
  }
}

if (start === -1) {
  console.log(`Release ${version}. See CHANGELOG.md for details.`);
  process.exit(0);
}

const out = [];
for (let i = start; i < lines.length; i++) {
  if (/^## /.test(lines[i])) break;
  out.push(lines[i]);
}
console.log(out.join("\n").trim() || `Release ${version}.`);
