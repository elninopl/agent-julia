// The hook command Claude Code runs. Written by `agent-julia hooks install`
// and rewritten at boot when its inputs change; it imports nothing but Node's
// own modules, so a prompt costs one node start and no package resolution.

export interface HookConstants {
  // Bumped when the script's behaviour changes, so an old copy is rewritten.
  version: number;
  stateDir: string;
  logFile: string;
  nudgeEveryTurns: number;
  extract: boolean;
  // How to start `claude`, e.g. ["/usr/local/bin/claude"].
  claudeCommand: string[];
  mcpConfigFile: string;
  childSettingsFile: string;
  model: string;
}

export const HOOK_SCRIPT_VERSION = 1;
export const HOOK_SCRIPT_NAME = "agent-julia-hook.mjs";

export function hookScript(c: HookConstants): string {
  return [
    "#!/usr/bin/env node",
    "// Written by agent-julia (`agent-julia hooks install`). Rewritten on update; do not edit.",
    `const C = ${JSON.stringify(c, null, 2)};`,
    BODY,
  ].join("\n");
}

// Plain JavaScript, kept free of backticks and template placeholders so it can
// sit in this string untouched.
const BODY = String.raw`
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync,
  readSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";

// The extraction child runs claude, which would run these hooks again.
if (process.env.AGENT_JULIA_HOOK_CHILD === "1") process.exit(0);

const mode = process.argv[2];

function log(line) {
  try {
    if (existsSync(C.logFile) && statSync(C.logFile).size > 1024 * 1024) renameSync(C.logFile, C.logFile + ".1");
    appendFileSync(C.logFile, new Date().toISOString() + " " + line + "\n");
  } catch {}
}

function readStdin(ms) {
  return new Promise((resolve) => {
    let data = "";
    const done = () => resolve(data);
    const timer = setTimeout(done, ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { data += d; if (data.length > 1e6) { clearTimeout(timer); done(); } });
    process.stdin.on("end", () => { clearTimeout(timer); done(); });
  });
}

const safeId = (s) => String(s || "unknown").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "unknown";

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}

// Phrases that usually mean the user is correcting how the assistant writes
// or speaks. A false hit costs one line of context; a miss loses the rule.
const CORRECTION = new RegExp([
  "nie pisz", "nie mów", "nie używaj", "nie nazywaj", "przestań", "źle brzmi", "brzmi źle",
  "dziwnie brzmi", "brzmi dziwnie", "zamiast", "nie tak się", "mów do mnie", "pisz do mnie",
  "don't write", "do not write", "don't say", "do not say", "stop saying", "stop using",
  "never say", "never write", "sounds off", "sounds wrong", "sounds weird", "that phrasing",
  "instead of saying", "call me ",
].join("|"), "iu");

function prune(dir, days) {
  const marker = join(dir, ".pruned");
  try {
    if (existsSync(marker) && Date.now() - statSync(marker).mtimeMs < 86400000) return;
    writeFileSync(marker, "");
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (f !== ".pruned" && Date.now() - statSync(p).mtimeMs > days * 86400000) unlinkSync(p);
    }
  } catch {}
}

async function onPrompt() {
  const input = JSON.parse((await readStdin(2000)) || "{}");
  const lines = [];
  if (typeof input.prompt === "string" && CORRECTION.test(input.prompt)) {
    lines.push("agent-julia: this message may correct how you write or speak. If it does, call correct_voice with the rule before you reply, then confirm it is saved.");
  }
  const dir = join(C.stateDir, "sessions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, safeId(input.session_id) + ".json");
  const s = readJson(file, { turns: 0, nudgedAt: 0 });
  s.turns += 1;
  if (C.nudgeEveryTurns > 0 && s.turns - s.nudgedAt >= C.nudgeEveryTurns) {
    lines.push("agent-julia: " + (s.turns - s.nudgedAt) + " turns since the last reminder. If this session produced a durable fact, decision or preference that is not saved yet, ingest it now and say so in one line.");
    s.nudgedAt = s.turns;
  }
  writeFileSync(file, JSON.stringify(s));
  prune(dir, 14);
  if (lines.length) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: lines.join("\n") } }));
  }
}

// The text of the transcript from a byte offset on: what the user wrote and
// what the assistant answered, without tool traffic.
function digest(file, from) {
  const size = statSync(file).size;
  if (size <= from) return { text: "", end: from };
  const fd = openSync(file, "r");
  const buf = Buffer.alloc(size - from);
  readSync(fd, buf, 0, buf.length, from);
  closeSync(fd);
  const raw = buf.toString("utf8");
  const cut = raw.lastIndexOf("\n");
  if (cut < 0) return { text: "", end: from };
  const out = [];
  for (const line of raw.slice(0, cut).split("\n")) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const role = e && e.message && e.message.role;
    if (role !== "user" && role !== "assistant") continue;
    if (e.isMeta) continue;
    const content = e.message.content;
    const parts = typeof content === "string" ? [content]
      : Array.isArray(content) ? content.filter((b) => b && b.type === "text").map((b) => b.text) : [];
    const text = parts.join("\n").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
    if (text) out.push((role === "user" ? "USER: " : "ASSISTANT: ") + text);
  }
  return { text: out.join("\n\n"), end: from + Buffer.byteLength(raw.slice(0, cut + 1), "utf8") };
}

const INSTRUCTION = [
  "You keep the user's long-term memory in agent-julia. Below is part of a working session between the user and an assistant.",
  "Find what is worth remembering beyond this session: durable facts, decisions and preferences about the user or their projects, and corrections to how the assistant should write or speak.",
  "For each one, search the memory first. If it is already there, skip it. Otherwise ingest it into the page it belongs to, or call correct_voice for a correction of voice.",
  "Never save passwords, API keys, tokens, card or bank numbers, exact amounts of money, or private details about other people. Skip anything transient.",
  "If nothing qualifies, save nothing. Answer with one short line per item saved, or the word nothing.",
  "",
  "--- session ---",
  "",
].join("\n");

async function onExtract() {
  if (!C.extract) return;
  const input = JSON.parse((await readStdin(2000)) || "{}");
  const file = input.transcript_path;
  if (!file || !existsSync(file)) return;
  const dir = join(C.stateDir, "extract");
  mkdirSync(dir, { recursive: true });
  const mark = join(dir, safeId(input.session_id) + ".json");
  const done = readJson(mark, { offset: 0 });
  const { text, end } = digest(file, done.offset);
  writeFileSync(mark, JSON.stringify({ offset: end, at: new Date().toISOString() }));
  prune(dir, 30);
  if (text.length < 400) return;
  const MAX = 80000;
  const body = text.length > MAX ? text.slice(text.length - MAX) : text;
  const job = join(dir, safeId(input.session_id) + "-" + Date.now() + ".job");
  writeFileSync(job, INSTRUCTION + body);
  const child = spawn(process.execPath, [process.argv[1], "run", job], { detached: true, stdio: "ignore" });
  child.unref();
  log("extract queued: session " + safeId(input.session_id) + " (" + (input.hook_event_name || "?") + "), " + body.length + " chars");
}

// Detached from the session: runs claude over one job, time-boxed.
function onRun(job) {
  const [cmd, ...pre] = C.claudeCommand;
  const args = [...pre, "-p", "--model", C.model, "--strict-mcp-config", "--mcp-config", C.mcpConfigFile,
    "--allowedTools", "mcp__agent-julia__search,mcp__agent-julia__read,mcp__agent-julia__ingest,mcp__agent-julia__correct_voice",
    "--disallowedTools", "mcp__agent-julia__archive,mcp__agent-julia__retract_correction,mcp__agent-julia__maintenance",
    "--settings", C.childSettingsFile];
  const win = process.platform === "win32";
  const quoted = win ? args.map((a) => (/[\s"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a)) : args;
  const child = spawn(win && !/\.exe$/i.test(cmd) ? '"' + cmd + '"' : cmd, quoted, {
    cwd: C.stateDir,
    env: { ...process.env, AGENT_JULIA_HOOK_CHILD: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    shell: win,
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const timer = setTimeout(() => { log("extract timed out after 5 min: " + job); child.kill(); }, 5 * 60 * 1000);
  child.on("error", (err) => { log("extract could not start claude: " + err.message); });
  child.on("close", (code) => {
    clearTimeout(timer);
    log("extract finished (exit " + code + "): " + out.trim().replace(/\s+/g, " ").slice(0, 400));
    try { unlinkSync(job); } catch {}
  });
  child.stdin.end(readFileSync(job, "utf8"));
}

try {
  if (mode === "prompt") await onPrompt();
  else if (mode === "extract") await onExtract();
  else if (mode === "run") onRun(process.argv[3]);
} catch (err) {
  log("hook " + mode + " failed: " + (err && err.message));
}
`;

// What settings.json must not mistake for anyone else's hook: every command
// agent-julia writes names this file.
export function ownsCommand(command: unknown): boolean {
  return typeof command === "string" && command.includes(HOOK_SCRIPT_NAME);
}
