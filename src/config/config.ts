import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
  // Always resolve directories to absolute paths for downstream consumers.
  return withAbsoluteDirs(ConfigSchema.parse(raw));
}

// memoryDir, personaDir and every mounted store's dir, made absolute. A field
// that is not set stays absent rather than becoming `undefined`, so a config
// from an earlier version comes back with exactly the keys it had.
export function withAbsoluteDirs(cfg: Config): Config {
  const abs = (p: string) => resolve(expandPath(p));
  const out: Config = { ...cfg, memoryDir: abs(cfg.memoryDir) };
  if (cfg.personaDir !== undefined) out.personaDir = abs(cfg.personaDir);
  if (cfg.stores !== undefined) out.stores = cfg.stores.map((s) => ({ ...s, dir: abs(s.dir) }));
  return out;
}

// Keep this many previous versions of the config. It is one small file holding
// the identity, the voice preset and the path to everything the user owns; a
// stray script that rewrites it leaves them with an agent that knows nothing
// and no way back. Cheap insurance.
const CONFIG_BACKUPS = 5;

async function rotateBackups(path: string): Promise<void> {
  if (!existsSync(path)) return;
  for (let i = CONFIG_BACKUPS - 1; i >= 1; i--) {
    const from = `${path}.${i}.bak`;
    const to = `${path}.${i + 1}.bak`;
    if (existsSync(from)) await rename(from, to).catch(() => undefined);
  }
  await copyFile(path, `${path}.1.bak`).catch(() => undefined);
}

export async function saveConfig(cfg: Config): Promise<string> {
  const path = configPath();

  // A test run must never touch the real config. test/setup.ts pins
  // AGENT_JULIA_CONFIG at a throwaway file, but an ad-hoc script that imports
  // this module and forgets to would silently repoint someone's memory at a
  // temp directory that is about to be deleted. That has happened.
  if ((process.env.VITEST || process.env.NODE_ENV === "test") && !path.startsWith(tmpdir())) {
    throw new Error(
      `refusing to write the real config at ${path} from a test run — ` +
        "set AGENT_JULIA_CONFIG to a temp path first",
    );
  }

  await mkdir(dirname(path), { recursive: true });
  await rotateBackups(path);

  // Directories are persisted as resolved absolute paths, never as typed (with
  // a ~ or relative to some cwd), so the file means the same from anywhere.
  const toWrite = withAbsoluteDirs(cfg);
  // Temp file plus rename: a crash or a full disk leaves the previous config
  // intact rather than a truncated one that fails to parse on the next start.
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(toWrite, null, 2) + "\n", "utf8");
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  return path;
}

// The most recent backups of the config, newest first. `doctor` points at these
// when the configured memory directory has gone missing.
export function configBackups(): string[] {
  const path = configPath();
  const out: string[] = [];
  for (let i = 1; i <= CONFIG_BACKUPS; i++) {
    const p = `${path}.${i}.bak`;
    if (existsSync(p)) out.push(p);
  }
  return out;
}
