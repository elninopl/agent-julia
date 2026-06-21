import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION, Config } from "../config/schema.js";
import { saveConfig } from "../config/config.js";
import { StorePaths, storePaths } from "../store/paths.js";
import { commitAll } from "../store/git.js";
import { log } from "../util/log.js";
import { todayISO } from "../store/markdown.js";
import { Migration, MigrationContext } from "./types.js";
import { migration0001 } from "./0001-initial.js";

// Ordered registry. Append new steps here; never reorder or mutate shipped ones.
const MIGRATIONS: Migration[] = [migration0001];

interface MigrationState {
  applied: number[];
  schemaVersion: number;
}

async function readState(paths: StorePaths): Promise<MigrationState> {
  if (!existsSync(paths.migrationStatePath)) return { applied: [], schemaVersion: 0 };
  try {
    return JSON.parse(await readFile(paths.migrationStatePath, "utf8")) as MigrationState;
  } catch {
    return { applied: [], schemaVersion: 0 };
  }
}

async function writeState(paths: StorePaths, state: MigrationState): Promise<void> {
  await mkdir(paths.internalDir, { recursive: true });
  await writeFile(paths.migrationStatePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

// Brings an older store up to the current schema on startup. Each step is ordered,
// idempotent, and backed up before it touches user data, so an upgrade is either
// backward-compatible or migrated transparently — never a manual fix.
export async function migrate(config: Config): Promise<{ config: Config; ranAny: boolean }> {
  const paths = storePaths(config.memoryDir);
  const state = await readState(paths);
  const fromVersion = Math.max(state.schemaVersion, 0);

  const pending = MIGRATIONS.filter(
    (m) => m.version > fromVersion && !state.applied.includes(m.version),
  ).sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    // Ensure schemaVersion is recorded even on a fresh, already-current store.
    if (state.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      await writeState(paths, {
        applied: MIGRATIONS.filter((m) => m.version <= CURRENT_SCHEMA_VERSION).map((m) => m.version),
        schemaVersion: CURRENT_SCHEMA_VERSION,
      });
    }
    return { config, ranAny: false };
  }

  const ctx: MigrationContext = {
    paths,
    config,
    backup: (label) => backupStore(paths, label),
    commit: (message) => commitAll(paths.root, message),
  };

  for (const m of pending) {
    log(`migrating to schemaVersion ${m.version}: ${m.description}`);
    // Backup before any potentially destructive step (skip on a brand-new store).
    if (existsSync(paths.indexMd)) await ctx.backup(`pre-v${m.version}`);
    await m.up(ctx);
    state.applied.push(m.version);
    state.schemaVersion = m.version;
    await writeState(paths, state);
    await ctx.commit(`chore(migrate): apply schema migration v${m.version} (${m.description})`);
  }

  const updated: Config = { ...config, schemaVersion: CURRENT_SCHEMA_VERSION };
  await saveConfig(updated);
  return { config: updated, ranAny: true };
}

// Copy the markdown store (excluding the disposable index) into a timestamped
// backup folder, so a migration can never lose user data.
async function backupStore(paths: StorePaths, label: string): Promise<string> {
  const dest = join(paths.backupsDir, `${todayISO()}-${label}`);
  await mkdir(dest, { recursive: true });
  for (const name of ["index.md", "log.md", "voice-corrections.md", "pages", "archive"]) {
    const src = join(paths.root, name);
    if (existsSync(src)) await cp(src, join(dest, name), { recursive: true });
  }
  log(`backup written to ${dest}`);
  return dest;
}
