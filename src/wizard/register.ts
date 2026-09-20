import { existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, sep } from "node:path";
import { Config, Surface } from "../config/schema.js";
import { log, warn } from "../util/log.js";
import { copyToClipboard } from "../util/clipboard.js";
import { buildInjectedCore, STARTUP_BLOCK_ID } from "../persona/startup.js";
import { storePaths } from "../store/paths.js";
import { endMarker, hasManagedBlock, removeManagedBlock, startMarker, upsertManagedBlock } from "../managed/block.js";
import { installSkills, skillsTargetDir, uninstallSkills } from "../skills/install.js";
import { EXPORT_BLOCK_ID as EXPORTED_BLOCK_ID } from "../export/export.js";

export interface ServerEntry {
  command: string;
  args: string[];
}

// Candidate ways to launch the server, best first. The running copy is stable
// and can see its own siblings; a globally installed one likewise; npx keeps
// everyone on @latest but runs from a cache directory that cannot resolve an
// optional peer dependency installed anywhere else — which is exactly why local
// embeddings could be chosen, downloaded, indexed, and still never load.
function candidates(): ServerEntry[] {
  const out: ServerEntry[] = [];
  const entry = process.argv[1];
  if (entry && !entry.includes(`${sep}_npx${sep}`) && existsSync(entry)) {
    try {
      out.push({ command: process.execPath, args: [realpathSync(entry), "serve"] });
    } catch {
      // unreadable — skip it
    }
  }
  const global = globalBinary();
  if (global && !out.some((c) => c.args[0] === global)) {
    out.push({ command: process.execPath, args: [global, "serve"] });
  }
  out.push({ command: "npx", args: ["-y", "agent-julia@latest", "serve"] });
  return out;
}

function globalBinary(): string | null {
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    const entry = join(root, "agent-julia", "dist", "index.js");
    return existsSync(entry) ? realpathSync(entry) : null;
  } catch {
    return null;
  }
}

// Can the server this command would start load the local embedding model?
// Asking the candidate itself is the only honest test: resolution depends on
// where that copy lives, not on where the wizard is running.
function canEmbed(entry: ServerEntry): boolean {
  try {
    execFileSync(entry.command, [...entry.args.slice(0, -1), "probe-embeddings"], {
      stdio: "ignore",
      timeout: 60_000,
    });
    return true;
  } catch {
    return false;
  }
}

// How the Claude clients will launch the server. With local embeddings chosen,
// a candidate that cannot load the model is not a candidate: registering it
// would mean a configured, downloaded, fully indexed model that never runs.
export function serverEntryFor(needsLocalEmbeddings: boolean): ServerEntry {
  const list = candidates();
  if (needsLocalEmbeddings) {
    for (const c of list) {
      if (canEmbed(c)) return c;
    }
    warn(
      "no way of launching agent-julia on this machine can load the local embedding model; " +
        "registering the default. `agent-julia doctor` will keep saying so until you run " +
        "`npm i -g agent-julia @huggingface/transformers` and re-run `agent-julia sync`.",
    );
  }
  return list[0]!;
}

function serverEntry(): ServerEntry {
  return candidates()[0]!;
}

// Claude Desktop config — the file that registers the MCP server for Cowork.
export function desktopConfigPath(): string | null {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default:
      // Best-guess for other platforms; verify it matches your Claude install.
      return join(home, ".config", "Claude", "claude_desktop_config.json");
  }
}

// Claude Code user-scoped config + startup instructions file.
export function claudeCodeConfigPath(): string {
  return join(homedir(), ".claude.json");
}
export function claudeCodeMemoryPath(): string {
  return join(homedir(), ".claude", "CLAUDE.md");
}

// On-disk mirror of the Cowork Global instructions block. Cowork stores that field
// inside the app, not on disk; this keeps an auditable copy the user can paste in.
export function coworkMirrorPath(): string {
  return join(homedir(), ".config", "agent-julia", "cowork-global-instructions.md");
}

// Hash of the core the user was last ASKED to paste into Cowork (written by
// init/sync when they issue the paste step). The in-app field can't be read, so
// this is the best available signal: when the current core differs from this
// hash, the Cowork persona has drifted and needs a re-paste — `doctor` flags it.
export function coworkPasteMarkerPath(): string {
  return join(homedir(), ".config", "agent-julia", "cowork-pasted.sha1");
}

export function coreHash(core: string): string {
  return createHash("sha1").update(core.trim()).digest("hex");
}

// Returns false (without throwing) if the file exists but isn't valid JSON, so
// the caller can fall back to a manual step instead of reporting a false success.
export async function mergeMcpServerForTest(path: string, name: string, entry: ServerEntry = serverEntry()): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  let data: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      data = JSON.parse(await readFile(path, "utf8"));
    } catch (err) {
      warn(`could not parse ${path}, leaving it untouched:`, (err as Error).message);
      return false;
    }
  }
  const servers = (data.mcpServers as Record<string, unknown>) ?? {};
  servers[name] = entry;
  data.mcpServers = servers;
  // Same care as the markdown files this package writes: a one-time backup of
  // the original, and a temp-file rename. ~/.claude.json is Claude Code's live
  // state, and a truncated one is a broken install.
  const bak = `${path}.agent-julia-bak`;
  if (existsSync(path) && !existsSync(bak)) await copyFile(path, bak);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmp, path);
  log(`registered MCP server '${name}' in ${path}`);
  return true;
}

// The manual fallback when we can't safely write a Claude config file.
function manualMcpStep(surface: Surface, action: string, path: string): InstallStep {
  return {
    surface,
    action,
    status: "manual",
    detail: [
      `Couldn't safely edit ${path} (it isn't valid JSON). Add this yourself, under the top-level object:`,
      mcpSnippet(),
    ].join("\n"),
  };
}

async function removeMcpServer(path: string, name: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    const data = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const servers = data.mcpServers as Record<string, unknown> | undefined;
    if (!servers || !(name in servers)) return false;
    delete servers[name];
    await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

export interface InstallStep {
  surface: Surface | "shared";
  action: string;
  status: "done" | "skipped" | "manual";
  detail: string;
}

// Register the MCP server AND inject the startup persona core for the selected
// surfaces. Two distinct jobs — registering the server is not enough; the persona
// + "use your memory" instruction must be in each surface's startup context,
// because the model reads those before anything else.
export async function install(config: Config): Promise<InstallStep[]> {
  const steps: InstallStep[] = [];
  const name = "agent-julia";
  // Chosen once, and probed when it has to be: with local embeddings selected,
  // registering a launcher that cannot load the model is how a fully configured
  // and fully indexed semantic search ends up never running.
  const entry = serverEntryFor(config.embedding.provider === "local");
  const core = await buildInjectedCore(storePaths(config.memoryDir), config);
  const wantCode = config.surfaces.includes("code");
  const wantDesktop = config.surfaces.includes("cowork") || config.surfaces.includes("dispatch");

  // --- MCP registration ---
  if (wantCode) {
    const p = claudeCodeConfigPath();
    const wrote = await mergeMcpServerForTest(p, name, entry);
    steps.push(
      wrote
        ? { surface: "code", action: "register MCP", status: "done", detail: `${p} — ${entry.command} ${entry.args.join(" ")}` }
        : manualMcpStep("code", "register MCP", p),
    );
  }
  if (wantDesktop) {
    const p = desktopConfigPath();
    if (p) {
      const wrote = await mergeMcpServerForTest(p, name, entry);
      steps.push(
        wrote
          ? {
              surface: "cowork",
              action: "register MCP (Cowork)",
              status: "done",
              detail: p,
            }
          : manualMcpStep("cowork", "register MCP (Cowork)", p),
      );
    } else {
      steps.push({ surface: "cowork", action: "register MCP", status: "skipped", detail: "unsupported platform" });
    }
  }

  // --- Startup persona core injection ---
  if (wantCode) {
    const mem = claudeCodeMemoryPath();
    const res = await upsertManagedBlock(mem, STARTUP_BLOCK_ID, core);
    steps.push({
      surface: "code",
      action: "inject persona core",
      status: "done",
      detail: `${mem}${res.backedUp ? " (original backed up)" : ""}`,
    });
  }
  if (config.surfaces.includes("cowork") || config.surfaces.includes("dispatch")) {
    const mirror = coworkMirrorPath();
    await upsertManagedBlock(mirror, STARTUP_BLOCK_ID, core);
    // Cowork keeps Global instructions inside the app — we can't write that field,
    // so the user pastes it. Put it on the clipboard to make that one action, not
    // a file hunt. Best-effort: if there's no clipboard, fall back to the path.
    const copied = await copyToClipboard(await readFile(mirror, "utf8"));
    const detail = copied
      ? [
          "Copied to your clipboard — paste it once:",
          "  1. Claude Desktop → Settings → Cowork → Global instructions",
          "  2. paste (⌘V / Ctrl-V) and save",
          "  3. restart Claude Desktop",
        ]
      : [
          "Cowork keeps Global instructions inside the app, so paste it once:",
          `  1. open this file:  ${mirror}`,
          "  2. copy everything in it",
          "  3. in Claude Desktop: Settings → Cowork → Global instructions → paste",
        ];
    steps.push({
      surface: "cowork",
      action: "paste the persona core into Cowork",
      status: "manual",
      detail: detail.join("\n"),
    });
    // Record what the user was asked to paste, so `doctor` can tell when the
    // core has drifted from the Cowork field since.
    await writeFile(coworkPasteMarkerPath(), coreHash(core) + "\n", "utf8");
  }

  // --- Shipped skills ---
  // ~/.claude/skills is read by Claude Code and Cowork alike, so one copy serves
  // every selected surface.
  for (const s of await installSkills(skillsTargetDir())) {
    steps.push({ surface: "shared", action: `install skill '${s.skill}'`, status: s.status, detail: s.detail });
  }

  return steps;
}

// Refresh the persona block in files that already carry it — the boot-time half
// of propagation. init/sync CREATE the block (an explicit opt-in we never make
// for the user); this only keeps existing blocks current, so voice updates and
// corrections reach every surface without a manual `sync`. Files are rewritten
// only when the block's content actually changed. Returns the refresh count.
// Target paths are injectable for tests; callers use the default.
export async function refreshInjectedCore(
  config: Config,
  targets: string[] = [claudeCodeMemoryPath(), coworkMirrorPath()],
): Promise<number> {
  const core = await buildInjectedCore(storePaths(config.memoryDir), config);
  const block = `${startMarker(STARTUP_BLOCK_ID)}\n${core.trim()}\n${endMarker(STARTUP_BLOCK_ID)}`;
  let refreshed = 0;
  for (const p of targets) {
    if (!existsSync(p)) continue;
    const content = await readFile(p, "utf8");
    if (!hasManagedBlock(content, STARTUP_BLOCK_ID) || content.includes(block)) continue;
    await upsertManagedBlock(p, STARTUP_BLOCK_ID, core);
    refreshed++;
  }
  return refreshed;
}

// The mcpServers snippet to add to a Claude client config, as pretty JSON.
function mcpSnippet(entry: ServerEntry = serverEntry()): string {
  return JSON.stringify({ mcpServers: { "agent-julia": entry } }, null, 2);
}

// Produce a manual setup guide instead of writing the files, for users who prefer
// to change their own Claude config. Lists exactly what to add and where.
export async function buildInstructions(config: Config): Promise<string> {
  const core = await buildInjectedCore(storePaths(config.memoryDir), config);
  const out: string[] = [];
  const wantCode = config.surfaces.includes("code");
  const wantDesktop = config.surfaces.includes("cowork") || config.surfaces.includes("dispatch");

  if (wantCode) {
    out.push(
      "Claude Code",
      `  1. In ${claudeCodeConfigPath()}, merge this into the top-level object:`,
      mcpSnippet().replace(/^/gm, "     "),
      `  2. Append this block to ${claudeCodeMemoryPath()}:`,
      core.replace(/^/gm, "     "),
      "",
    );
  }
  if (wantDesktop) {
    const desktop = desktopConfigPath();
    out.push(
      "Claude Desktop (Cowork)",
      `  1. In ${desktop ?? "<Claude Desktop config>"}, merge this into the top-level object:`,
      mcpSnippet().replace(/^/gm, "     "),
      "  2. Paste this block into Settings → Cowork → Global instructions:",
      core.replace(/^/gm, "     "),
      "",
    );
  }
  out.push(
    "Skills",
    `  Copy the packaged skill folders (dist/skills/assets/* inside the agent-julia package) into ${skillsTargetDir()}.`,
    "",
  );
  out.push("Restart your Claude apps afterwards.");
  return out.join("\n");
}

// Reverse everything install() did: strip managed blocks and unregister the MCP
// server. The one-time *.agent-julia-bak backups are left in place for recovery.
export async function uninstall(): Promise<InstallStep[]> {
  const steps: InstallStep[] = [];
  const name = "agent-julia";

  for (const p of [claudeCodeConfigPath(), desktopConfigPath()].filter(Boolean) as string[]) {
    const removed = await removeMcpServer(p, name);
    steps.push({
      surface: "shared",
      action: "unregister MCP",
      status: removed ? "done" : "skipped",
      detail: p,
    });
  }

  for (const p of [claudeCodeMemoryPath(), coworkMirrorPath()]) {
    const removed = await removeManagedBlock(p, STARTUP_BLOCK_ID);
    steps.push({
      surface: "shared",
      action: "remove persona core",
      status: removed ? "done" : "skipped",
      detail: p,
    });
  }

  for (const s of await uninstallSkills(skillsTargetDir())) {
    steps.push({ surface: "shared", action: `remove skill '${s.skill}'`, status: s.status, detail: s.detail });
  }

  // Everything else this package wrote outside the two Claude files. Uninstall
  // never loaded the config, so a persona exported into ~/.codex/AGENTS.md stayed
  // there forever while the CLI printed "managed blocks removed".
  try {
    const { loadConfig } = await import("../config/config.js");
    const cfg = await loadConfig();
    for (const target of cfg.exports) {
      const removed = await removeManagedBlock(target, EXPORTED_BLOCK_ID);
      steps.push({
        surface: "shared",
        action: "remove exported persona",
        status: removed ? "done" : "skipped",
        detail: target,
      });
    }
  } catch {
    steps.push({
      surface: "shared",
      action: "remove exported personas",
      status: "skipped",
      detail: "no readable config — check ~/.codex/AGENTS.md and any other export targets by hand",
    });
  }

  // The record of what the user was last asked to paste into Claude Desktop.
  // Leaving it behind makes a later reinstall claim the in-app copy is current.
  const marker = coworkPasteMarkerPath();
  if (existsSync(marker)) {
    await rm(marker, { force: true });
    steps.push({ surface: "shared", action: "clear Cowork paste marker", status: "done", detail: marker });
  }

  steps.push({
    surface: "shared",
    action: "left in place",
    status: "skipped",
    detail:
      "your memory store, your config (~/.config/agent-julia) and every *.agent-julia-bak backup. " +
      "Delete them yourself if you want them gone; nothing here touches your data.",
  });
  return steps;
}
