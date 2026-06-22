import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { Config, Surface } from "../config/schema.js";
import { log, warn } from "../util/log.js";
import { buildStartupCore, STARTUP_BLOCK_ID } from "../persona/startup.js";
import { removeManagedBlock, upsertManagedBlock } from "../managed/block.js";

// The MCP entry every surface gets. Floating @latest auto-propagates next session.
function serverEntry(): { command: string; args: string[] } {
  return { command: "npx", args: ["-y", "agent-julia@latest", "serve"] };
}

// Claude Desktop config — one file that covers BOTH Cowork and Dispatch.
function desktopConfigPath(): string | null {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default:
      return join(home, ".config", "Claude", "claude_desktop_config.json");
  }
}

// Claude Code user-scoped config + startup instructions file.
function claudeCodeConfigPath(): string {
  return join(homedir(), ".claude.json");
}
function claudeCodeMemoryPath(): string {
  return join(homedir(), ".claude", "CLAUDE.md");
}

// On-disk mirror of the Cowork Global instructions block. Cowork stores that field
// inside the app, not on disk; this keeps an auditable copy the user can paste in.
function coworkMirrorPath(): string {
  return join(homedir(), ".config", "agent-julia", "cowork-global-instructions.md");
}

async function mergeMcpServer(path: string, name: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let data: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      data = JSON.parse(await readFile(path, "utf8"));
    } catch (err) {
      warn(`could not parse ${path}, leaving it untouched:`, (err as Error).message);
      return;
    }
  }
  const servers = (data.mcpServers as Record<string, unknown>) ?? {};
  servers[name] = serverEntry();
  data.mcpServers = servers;
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
  log(`registered MCP server '${name}' in ${path}`);
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
  const core = buildStartupCore(config);
  const wantCode = config.surfaces.includes("code");
  const wantDesktop = config.surfaces.includes("cowork") || config.surfaces.includes("dispatch");

  // --- MCP registration ---
  if (wantCode) {
    const p = claudeCodeConfigPath();
    await mergeMcpServer(p, name);
    steps.push({ surface: "code", action: "register MCP", status: "done", detail: p });
  }
  if (wantDesktop) {
    const p = desktopConfigPath();
    if (p) {
      await mergeMcpServer(p, name);
      steps.push({
        surface: "cowork",
        action: "register MCP (covers Cowork + Dispatch)",
        status: "done",
        detail: p,
      });
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
    steps.push({
      surface: "cowork",
      action: "inject persona core",
      status: "manual",
      detail: `Mirror written to ${mirror}. Paste its content into Settings -> Cowork -> Global instructions (app-stored, also covers Dispatch).`,
    });
  }

  return steps;
}

// The mcpServers snippet to add to a Claude client config, as pretty JSON.
function mcpSnippet(): string {
  return JSON.stringify({ mcpServers: { "agent-julia": serverEntry() } }, null, 2);
}

// Produce a manual setup guide instead of writing the files, for users who prefer
// to change their own Claude config. Lists exactly what to add and where.
export function buildInstructions(config: Config): string {
  const core = buildStartupCore(config);
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
      "Claude Desktop (covers Cowork + Dispatch)",
      `  1. In ${desktop ?? "<Claude Desktop config>"}, merge this into the top-level object:`,
      mcpSnippet().replace(/^/gm, "     "),
      "  2. Paste this block into Settings → Cowork → Global instructions:",
      core.replace(/^/gm, "     "),
      "",
    );
  }
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
  return steps;
}
