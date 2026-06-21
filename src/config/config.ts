import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandPath } from "../util/paths.js";
import { Config, ConfigSchema } from "./schema.js";

// Config lives outside the memory repo so the user's KB stays pure markdown.
// Order of resolution:
//   1. $AGENT_JULIA_CONFIG (explicit override)
//   2. ~/.config/agent-julia/config.json (XDG-ish default)
export function configPath(): string {
  const override = process.env.AGENT_JULIA_CONFIG;
  if (override) return expandPath(override);
  return join(homedir(), ".config", "agent-julia", "config.json");
}

export function configExists(): boolean {
  return existsSync(configPath());
}

export async function loadConfig(): Promise<Config> {
  const path = configPath();
  if (!existsSync(path)) {
    throw new Error(
      `No config found at ${path}. Run \`npx agent-julia init\` to set up your persona and memory.`,
    );
  }
  const raw = JSON.parse(await readFile(path, "utf8"));
  const cfg = ConfigSchema.parse(raw);
  // Always resolve memoryDir to an absolute path for downstream consumers.
  cfg.memoryDir = resolve(expandPath(cfg.memoryDir));
  return cfg;
}

export async function saveConfig(cfg: Config): Promise<string> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  // Store memoryDir as written by the user (may contain ~) is avoided — we persist
  // the resolved absolute path for stability across cwd changes.
  const toWrite: Config = { ...cfg, memoryDir: resolve(expandPath(cfg.memoryDir)) };
  await writeFile(path, JSON.stringify(toWrite, null, 2) + "\n", "utf8");
  return path;
}
