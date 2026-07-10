import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Config } from "../config/schema.js";
import { storePaths } from "../store/paths.js";
import { composeCore } from "../persona/compose.js";
import { endMarker, hasManagedBlock, removeManagedBlock, startMarker, upsertManagedBlock } from "../managed/block.js";

// The persona block for tools OUTSIDE the Claude ecosystem (Codex, Gemini CLI,
// anything reading an AGENTS.md-style file). It carries the persona only — the
// memory instruction assumes agent-julia's MCP tools are attached, which we
// can't know for a foreign tool, so it stays out. Distinct block id: a file
// could conceivably carry both an export and a Claude startup block.
export const EXPORT_BLOCK_ID = "persona-export";

// Conventional global instruction files, addressable by name.
const ALIASES: Record<string, string> = {
  codex: join(homedir(), ".codex", "AGENTS.md"),
  gemini: join(homedir(), ".gemini", "GEMINI.md"),
};

export function resolveExportTarget(target: string): string {
  const alias = ALIASES[target.toLowerCase()];
  if (alias) return alias;
  return isAbsolute(target) ? target : resolve(target);
}

export function knownAliases(): string[] {
  return Object.keys(ALIASES);
}

// Compose the exportable persona text (no memory instruction — see above).
export async function exportText(config: Config): Promise<string> {
  const core = await composeCore(storePaths(config.memoryDir), config);
  return core.text;
}

// Write (or refresh) the persona block in `path`. Returns the resolved path so
// the caller can record it in config.exports for boot-time refresh.
export async function exportPersona(config: Config, target: string): Promise<string> {
  const path = resolveExportTarget(target);
  await upsertManagedBlock(path, EXPORT_BLOCK_ID, await exportText(config));
  return path;
}

export async function removeExport(config: Config, target: string): Promise<{ path: string; removed: boolean }> {
  const path = resolveExportTarget(target);
  return { path, removed: await removeManagedBlock(path, EXPORT_BLOCK_ID) };
}

// Boot-time half: keep recorded export files current, same contract as
// refreshInjectedCore — only files that still carry the block are touched, and
// only when the content actually changed. Returns how many were rewritten.
export async function refreshExports(config: Config): Promise<number> {
  if (config.exports.length === 0) return 0;
  const text = await exportText(config);
  const block = `${startMarker(EXPORT_BLOCK_ID)}\n${text.trim()}\n${endMarker(EXPORT_BLOCK_ID)}`;
  let refreshed = 0;
  for (const p of config.exports) {
    if (!existsSync(p)) continue;
    const content = await readFile(p, "utf8");
    if (!hasManagedBlock(content, EXPORT_BLOCK_ID) || content.includes(block)) continue;
    await upsertManagedBlock(p, EXPORT_BLOCK_ID, text);
    refreshed++;
  }
  return refreshed;
}
