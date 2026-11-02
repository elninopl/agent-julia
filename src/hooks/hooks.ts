import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configPath, saveConfig } from "../config/config.js";
import { Config, captureSettings } from "../config/schema.js";
import { writeFileAtomic } from "../managed/block.js";
import { withFileLock } from "../managed/lock.js";
import { ServerEntry, serverEntryFor, stableNodePath } from "../wizard/register.js";
import { HOOK_SCRIPT_NAME, HOOK_SCRIPT_VERSION, HookConstants, hookScript, ownsCommand } from "./script.js";

// Claude Code moves all of its settings with CLAUDE_CONFIG_DIR (one directory
// per account), so the hooks go where the running account reads them.
export function claudeConfigDir(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return dir ? dir : join(homedir(), ".claude");
}

export function hooksDir(): string {
  return join(dirname(configPath()), "hooks");
}

// The extraction model. A cheap pass over text, not a design decision.
const EXTRACT_MODEL = "sonnet";

export interface HookPaths {
  settingsFile: string;
  dir: string;
}

export function hookPaths(opts: { claudeDir?: string; dir?: string } = {}): HookPaths {
  return {
    settingsFile: join(opts.claudeDir ?? claudeConfigDir(), "settings.json"),
    dir: opts.dir ?? hooksDir(),
  };
}

// What was found at install time and is needed again to rewrite the script.
interface InstallRecord {
  node: string;
  claudeCommand: string[];
  server: ServerEntry;
}

function findClaude(): string[] {
  try {
    const win = process.platform === "win32";
    const out = execFileSync(win ? "where" : "which", ["claude"], { encoding: "utf8" });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // An npm install on Windows lists a shell script with no extension first,
    // which cmd cannot run; the .cmd or .exe next to it can.
    const pick = win ? lines.find((l) => /\.(exe|cmd)$/i.test(l)) : lines[0];
    if (pick) return [pick];
  } catch {
    // not on PATH here; the hook's own PATH may still have it
  }
  return ["claude"];
}

function scriptFile(p: HookPaths): string {
  return join(p.dir, HOOK_SCRIPT_NAME);
}

function constantsFor(config: Config, p: HookPaths, rec: InstallRecord): HookConstants {
  const capture = captureSettings(config);
  return {
    version: HOOK_SCRIPT_VERSION,
    stateDir: p.dir,
    logFile: join(dirname(p.dir), "hooks.log"),
    nudgeEveryTurns: capture.nudgeEveryTurns,
    extract: capture.extractOnCompact,
    claudeCommand: rec.claudeCommand,
    mcpConfigFile: join(p.dir, "extract-mcp.json"),
    childSettingsFile: join(p.dir, "extract-settings.json"),
    model: EXTRACT_MODEL,
  };
}

// The script and the two files the extraction child reads. Returns whether
// anything changed.
async function writeHookFiles(config: Config, p: HookPaths, rec: InstallRecord): Promise<boolean> {
  await mkdir(p.dir, { recursive: true });
  const c = constantsFor(config, p, rec);
  const files: Array<[string, string]> = [
    [scriptFile(p), hookScript(c)],
    [
      c.mcpConfigFile,
      JSON.stringify(
        {
          mcpServers: {
            // The same persona as the session: this config, whatever the
            // child's environment says.
            "agent-julia": { ...rec.server, env: { AGENT_JULIA_CONFIG: configPath() } },
          },
        },
        null,
        2,
      ) + "\n",
    ],
    [c.childSettingsFile, JSON.stringify({ disableAllHooks: true }, null, 2) + "\n"],
    [join(p.dir, "install.json"), JSON.stringify(rec, null, 2) + "\n"],
  ];
  let changed = false;
  for (const [file, content] of files) {
    const current = existsSync(file) ? await readFile(file, "utf8") : null;
    if (current === content) continue;
    await writeFileAtomic(file, content);
    changed = true;
  }
  return changed;
}

type HookEntry = { type: string; command?: string; timeout?: number; async?: boolean };
type HookGroup = { matcher?: string; hooks?: HookEntry[] };
type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

const quote = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

function ourGroups(config: Config, p: HookPaths, rec: InstallRecord): Record<string, HookGroup[]> {
  const run = (mode: string) => `${quote(rec.node)} ${quote(scriptFile(p))} ${mode}`;
  const groups: Record<string, HookGroup[]> = {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: run("prompt"), timeout: 10 }] }],
  };
  if (captureSettings(config).extractOnCompact) {
    groups.PreCompact = [{ hooks: [{ type: "command", command: run("extract"), timeout: 10 }] }];
    // SessionEnd has a short budget; the command only starts a detached job.
    groups.SessionEnd = [{ hooks: [{ type: "command", command: run("extract"), timeout: 10, async: true }] }];
  }
  return groups;
}

// Settings with every hook agent-julia wrote taken out, and nothing else
// touched. Groups left empty by that are dropped, events left empty too.
export function withoutOurHooks(settings: Settings): Settings {
  if (!settings.hooks) return settings;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept = groups
      .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => !ownsCommand(h?.command)) } : g))
      .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  const next: Settings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

async function editSettings(file: string, edit: (s: Settings) => Settings): Promise<boolean> {
  await mkdir(dirname(file), { recursive: true });
  return withFileLock(file, async () => {
    const raw = existsSync(file) ? await readFile(file, "utf8") : null;
    let current: Settings = {};
    if (raw !== null && raw.trim()) {
      try {
        current = JSON.parse(raw) as Settings;
      } catch (err) {
        throw new Error(`${file} is not valid JSON (${(err as Error).message}); fix it, then run this again`);
      }
    }
    const next = edit(current);
    const text = JSON.stringify(next, null, 2) + "\n";
    if (raw !== null && JSON.stringify(JSON.parse(raw || "{}")) === JSON.stringify(next)) return false;
    const bak = `${file}.agent-julia-bak`;
    if (raw !== null && !existsSync(bak)) await copyFile(file, bak);
    await writeFileAtomic(file, text);
    return true;
  });
}

export interface HookInstallOptions {
  claudeDir?: string;
  dir?: string;
  claudeCommand?: string[];
  server?: ServerEntry;
  node?: string;
  // Tests write settings without touching the config file.
  persistConfig?: boolean;
}

export interface HookInstallResult {
  settingsFile: string;
  events: string[];
  settingsChanged: boolean;
  config: Config;
}

export async function installHooks(config: Config, opts: HookInstallOptions = {}): Promise<HookInstallResult> {
  const p = hookPaths(opts);
  const rec: InstallRecord = {
    node: opts.node ?? stableNodePath(process.execPath),
    claudeCommand: opts.claudeCommand ?? findClaude(),
    server: opts.server ?? serverEntryFor(false),
  };
  const next: Config = { ...config, capture: { ...captureSettings(config), hooks: true } };
  await writeHookFiles(next, p, rec);
  const groups = ourGroups(next, p, rec);
  const settingsChanged = await editSettings(p.settingsFile, (s) => {
    const clean = withoutOurHooks(s);
    const hooks = { ...(clean.hooks ?? {}) };
    for (const [event, ours] of Object.entries(groups)) hooks[event] = [...(hooks[event] ?? []), ...ours];
    return { ...clean, hooks };
  });
  if (opts.persistConfig !== false) await saveConfig(next);
  return { settingsFile: p.settingsFile, events: Object.keys(groups), settingsChanged, config: next };
}

export async function uninstallHooks(
  config: Config,
  opts: { claudeDir?: string; dir?: string; persistConfig?: boolean } = {},
): Promise<{ settingsFile: string; settingsChanged: boolean }> {
  const p = hookPaths(opts);
  const settingsChanged = existsSync(p.settingsFile) ? await editSettings(p.settingsFile, withoutOurHooks) : false;
  await rm(scriptFile(p), { force: true });
  if (opts.persistConfig !== false && config.capture?.hooks) {
    await saveConfig({ ...config, capture: { ...captureSettings(config), hooks: false } });
  }
  return { settingsFile: p.settingsFile, settingsChanged };
}

export interface HookStatus {
  enabled: boolean;
  settingsFile: string;
  events: string[];
  script: "current" | "outdated" | "missing";
  claude: string | null;
}

export async function hookStatus(config: Config, opts: { claudeDir?: string; dir?: string } = {}): Promise<HookStatus> {
  const p = hookPaths(opts);
  const events: string[] = [];
  if (existsSync(p.settingsFile)) {
    try {
      const s = JSON.parse(await readFile(p.settingsFile, "utf8")) as Settings;
      for (const [event, groups] of Object.entries(s.hooks ?? {})) {
        if (Array.isArray(groups) && groups.some((g) => g?.hooks?.some((h) => ownsCommand(h?.command)))) events.push(event);
      }
    } catch {
      // unreadable settings: nothing of ours can be in effect
    }
  }
  const rec = await readRecord(p);
  let script: HookStatus["script"] = "missing";
  if (existsSync(scriptFile(p)) && rec) {
    const want = hookScript(constantsFor(config, p, rec));
    script = (await readFile(scriptFile(p), "utf8")) === want ? "current" : "outdated";
  }
  return { enabled: captureSettings(config).hooks, settingsFile: p.settingsFile, events, script, claude: rec?.claudeCommand[0] ?? null };
}

async function readRecord(p: HookPaths): Promise<InstallRecord | null> {
  try {
    return JSON.parse(await readFile(join(p.dir, "install.json"), "utf8")) as InstallRecord;
  } catch {
    return null;
  }
}

// At boot: bring the script up to date with this version and the config
// (turn interval, extraction on or off). Settings are left as the user has
// them; only `hooks install` and `hooks uninstall` change those.
export async function refreshHookScript(config: Config, opts: { dir?: string } = {}): Promise<boolean> {
  if (!captureSettings(config).hooks) return false;
  const p = hookPaths(opts);
  const rec = await readRecord(p);
  if (!rec || !existsSync(scriptFile(p))) return false;
  return writeHookFiles(config, p, rec);
}
