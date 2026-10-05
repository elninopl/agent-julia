#!/usr/bin/env node
// Refuses text that names projects which must not appear in this public repo.
//
// The names themselves are never in the repo: they come from git config
// (`git config --global --add agentjulia.forbiddenName <name>`, one per name)
// or from $AJ_FORBIDDEN_NAMES (comma-separated, used by CI from a secret).
// Matching ignores case and diacritics, so one entry covers every spelling
// with or without accents, and only starts at a word start, so a name never
// matches in the middle of an unrelated word.
//
//   --staged          added lines and paths in the index (pre-commit)
//   --message <file>  a commit message (commit-msg)
//   --push            what a push sends: refs, messages, added lines (pre-push, refs on stdin)
//   --range <a..b>    the same for a revision range
//   --tree            every tracked file and path (CI, release)
//   --stdin           any text on stdin, e.g. a PR description before it is posted

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ZERO = /^0+$/;

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
}

function fold(text) {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function configuredNames() {
  const out = new Set();
  try {
    for (const n of git(["config", "--get-all", "agentjulia.forbiddenName"]).split("\n")) if (n.trim()) out.add(fold(n.trim()));
  } catch {
    // not set
  }
  for (const n of (process.env.AJ_FORBIDDEN_NAMES ?? "").split(/[,\n]/)) if (n.trim()) out.add(fold(n.trim()));
  return [...out];
}

const names = configuredNames();
if (names.length === 0) {
  console.error(
    "check-names: no names configured, refusing to pass blind.\n" +
      "Set them with: git config --global --add agentjulia.forbiddenName <name>  (one per name)\n" +
      "or AJ_FORBIDDEN_NAMES=a,b. Bypass a single commit or push with --no-verify.",
  );
  process.exit(2);
}
const patterns = names.map((n) => new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u"));

const hits = [];
function scan(where, text) {
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const folded = fold(line);
    if (patterns.some((p) => p.test(folded))) hits.push(`${where}${lines.length > 1 ? `:${i + 1}` : ""}: ${line.trim().slice(0, 160)}`);
  });
}

// Added lines of a unified or combined diff, with the file they belong to.
// A combined diff (merge commits, --cc) has one marker column per parent; a
// line is new in the result when any column says "+" and none says "-".
function scanDiff(label, diff) {
  let file = "";
  let cols = 1;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.replace(/^\+\+\+ (b\/)?/, "");
      if (file !== "/dev/null") scan(`${label}${label ? " " : ""}path`, file);
      continue;
    }
    if (line.startsWith("--- ")) continue;
    const hunk = /^(@@+) /.exec(line);
    if (hunk) {
      cols = hunk[1].length - 1;
      continue;
    }
    if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("rename to ")) {
      if (line.startsWith("rename to ")) scan(`${label} path`, line.slice(10));
      continue;
    }
    const marks = line.slice(0, cols);
    if (marks.includes("+") && !marks.includes("-") && /^[+ ]+$/.test(marks)) {
      scan(`${label}${label ? " " : ""}${file}`, line.slice(cols));
    }
  }
}

function scanCommits(shas) {
  for (const sha of shas) {
    const short = sha.slice(0, 8);
    scan(`${short} message`, git(["log", "-1", "--format=%B", sha]));
    scanDiff(short, git(["show", "--format=", "--cc", "-U0", "--no-color", "--no-ext-diff", sha]));
  }
}

function revList(args) {
  return git(["rev-list", ...args]).split("\n").filter(Boolean);
}

const [mode, arg] = process.argv.slice(2);
switch (mode) {
  case "--staged":
    scanDiff("", git(["diff", "--cached", "-U0", "--no-color", "--no-ext-diff"]));
    break;
  case "--message":
    scan("commit message", readFileSync(arg, "utf8").split("\n").filter((l) => !l.startsWith("#")).join("\n"));
    break;
  case "--range":
    scanCommits(revList([arg]));
    break;
  case "--push": {
    for (const line of readFileSync(0, "utf8").split("\n")) {
      const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
      if (!localSha || ZERO.test(localSha)) continue; // a deletion sends nothing
      scan("ref", `${localRef} ${remoteRef}`);
      const shas = remoteSha && !ZERO.test(remoteSha) ? revList([`${remoteSha}..${localSha}`]) : revList([localSha, "--not", "--remotes"]);
      scanCommits(shas);
    }
    break;
  }
  case "--tree":
    for (const path of git(["ls-files", "-z"]).split("\0").filter(Boolean)) {
      scan("path", path);
      let buf;
      try {
        buf = readFileSync(path);
      } catch {
        continue; // deleted in the working tree
      }
      if (buf.subarray(0, 8000).includes(0)) continue; // binary
      scan(path, buf.toString("utf8"));
    }
    break;
  case "--stdin":
    scan("stdin", readFileSync(0, "utf8"));
    break;
  default:
    console.error("usage: check-names.mjs --staged | --message <file> | --push | --range <a..b> | --tree | --stdin");
    process.exit(2);
}

if (hits.length > 0) {
  console.error(`check-names: ${hits.length} line(s) name a private project:\n  ${hits.slice(0, 50).join("\n  ")}`);
  if (hits.length > 50) console.error(`  … and ${hits.length - 50} more`);
  console.error("Reword them before this reaches GitHub (--no-verify bypasses the hook, on purpose only).");
  process.exit(1);
}
