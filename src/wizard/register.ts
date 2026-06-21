import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { Surface } from "../config/schema.js";
import { log, warn } from "../util/log.js";

// The MCP entry every surface gets. Floating @latest auto-propagates next session;
// document pinning in README for reproducibility.
function serverEntry(): { command: string; args: string[] } {
  return { command: "npx", args: ["-y", "agent-julia@latest", "serve"] };
}

// Claude Desktop (Cowork) config path per platform.
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

// Claude Code user-scoped config.
function claudeCodeConfigPath(): string {
  return join(homedir(), ".claude.json");
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

export interface RegistrationResult {
  surface: Surface;
  status: "registered" | "skipped" | "manual";
  detail: string;
}

// Register the server with the selected surfaces. Idempotent: re-running just
// rewrites the same entry.
export async function registerSurfaces(surfaces: Surface[]): Promise<RegistrationResult[]> {
  const out: RegistrationResult[] = [];
  const name = "agent-julia";

  for (const surface of surfaces) {
    if (surface === "code") {
      const p = claudeCodeConfigPath();
      await mergeMcpServer(p, name);
      out.push({ surface, status: "registered", detail: p });
    } else if (surface === "cowork") {
      const p = desktopConfigPath();
      if (!p) {
        out.push({ surface, status: "skipped", detail: "unsupported platform" });
        continue;
      }
      await mergeMcpServer(p, name);
      out.push({ surface, status: "registered", detail: p });
    } else {
      // Dispatch (mobile) has no local config to write; it shares the same memory
      // repo once synced. Surfaced as a manual step.
      out.push({
        surface,
        status: "manual",
        detail: "Dispatch shares the same memory repo — no local file to register.",
      });
    }
  }
  return out;
}
