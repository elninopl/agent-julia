import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// A managed block is a clearly-marked region agent-julia owns inside a file it
// does not otherwise control (e.g. ~/.claude/CLAUDE.md, a user's index.md). We
// only ever touch the region between our markers, so hand-written content around
// it is preserved — and the block is fully removable on uninstall.
export function startMarker(id: string): string {
  return `<!-- agent-julia:${id}:start — managed block, do not edit by hand -->`;
}
export function endMarker(id: string): string {
  return `<!-- agent-julia:${id}:end -->`;
}

function blockRegion(id: string): RegExp {
  const s = escapeRe(startMarker(id));
  const e = escapeRe(endMarker(id));
  return new RegExp(`${s}[\\s\\S]*?${e}`, "m");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One-time backup of the original, pre-agent-julia file, so the user can always
// recover the state from before we ever touched it.
async function backupOnce(filePath: string): Promise<void> {
  const bak = `${filePath}.agent-julia-bak`;
  if (existsSync(filePath) && !existsSync(bak)) {
    await copyFile(filePath, bak);
  }
}

export function hasManagedBlock(content: string, id: string): boolean {
  return blockRegion(id).test(content);
}

// Insert or replace our managed block. Existing user content is never altered:
// if the block exists we swap its body in place; otherwise we append it.
export async function upsertManagedBlock(
  filePath: string,
  id: string,
  body: string,
): Promise<{ created: boolean; backedUp: boolean }> {
  await mkdir(dirname(filePath), { recursive: true });
  const existed = existsSync(filePath);
  await backupOnce(filePath);

  // The body can carry user-authored text (voice corrections quote whatever the
  // user said). Strip anything that looks like our markers — a literal end
  // marker inside the body would close the region early and leak the rest of
  // the block as permanent user content on the next upsert.
  const safeBody = body.replace(/<!--\s*agent-julia:[\s\S]*?-->/g, "").trim();
  const block = `${startMarker(id)}\n${safeBody}\n${endMarker(id)}`;
  let current = existed ? await readFile(filePath, "utf8") : "";

  if (hasManagedBlock(current, id)) {
    // Function replacement: a plain string would reinterpret `$&`/`$'` inside
    // the block as regex replacement patterns and corrupt the content.
    current = current.replace(blockRegion(id), () => block);
  } else {
    const sep = current.length === 0 ? "" : current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    current = `${current}${sep}${block}\n`;
  }
  await writeFile(filePath, current, "utf8");
  return { created: !existed, backedUp: existed };
}

// Remove our managed block, leaving the rest of the file intact. Idempotent.
export async function removeManagedBlock(filePath: string, id: string): Promise<boolean> {
  if (!existsSync(filePath)) return false;
  const current = await readFile(filePath, "utf8");
  if (!hasManagedBlock(current, id)) return false;
  const cleaned = current.replace(blockRegion(id), "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  await writeFile(filePath, cleaned, "utf8");
  return true;
}
