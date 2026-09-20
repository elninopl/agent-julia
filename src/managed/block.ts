import { existsSync } from "node:fs";
import { warn } from "../util/log.js";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readlink, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { withFileLock } from "./lock.js";
import { basename, dirname, join, resolve } from "node:path";

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
  // Before the lock, not inside it: withFileLock puts its lockfile next to the
  // target, so a missing parent directory fails there with ENOENT instead of
  // being created — which is every fresh install, where neither ~/.claude nor
  // ~/.config/agent-julia exists yet.
  await mkdir(dirname(filePath), { recursive: true });
  return withFileLock(filePath, () => upsertLocked(filePath, id, body));
}

async function upsertLocked(
  filePath: string,
  id: string,
  body: string,
): Promise<{ created: boolean; backedUp: boolean }> {
  const existed = existsSync(filePath);
  await backupOnce(filePath);

  // The body can carry user-authored text (voice corrections quote whatever the
  // user said). Strip anything that looks like our markers — a literal end
  // marker inside the body would close the region early and leak the rest of
  // the block as permanent user content on the next upsert.
  const safeBody = body.replace(/<!--\s*agent-julia:[\s\S]*?-->/g, "").trim();
  const block = `${startMarker(id)}\n${safeBody}\n${endMarker(id)}`;
  let current = existed ? await readFile(filePath, "utf8") : "";

  // A file with a start marker and no end marker (a half-finished hand edit, a
  // truncated write) is not a block. Left alone, the next upsert's region regex
  // would not match, the block would be appended below it, and every later
  // uninstall or refresh would see two starts and one end.
  const strayStart = new RegExp(`agent-julia:${escapeRe(id)}:start`);
  if (!hasManagedBlock(current, id) && strayStart.test(current)) {
    warn(`${filePath} has an agent-julia start marker with no end marker; removing the stray line`);
    current = current
      .split("\n")
      .filter((l) => !strayStart.test(l))
      .join("\n");
  }

  if (hasManagedBlock(current, id)) {
    // Function replacement: a plain string would reinterpret `$&`/`$'` inside
    // the block as regex replacement patterns and corrupt the content.
    current = current.replace(blockRegion(id), () => block);
  } else {
    const sep = current.length === 0 ? "" : current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    current = `${current}${sep}${block}\n`;
  }
  await writeFileAtomic(filePath, current);
  return { created: !existed, backedUp: existed };
}

// Remove our managed block, leaving the rest of the file intact. Idempotent.
// Locked and atomic for the same reason the upsert is: this reads a file the
// user wrote, edits one region of it, and writes the whole thing back.
export async function removeManagedBlock(filePath: string, id: string): Promise<boolean> {
  if (!existsSync(filePath)) return false;
  return withFileLock(filePath, async () => {
    const current = await readFile(filePath, "utf8");
    if (!hasManagedBlock(current, id)) return false;
    const cleaned = current.replace(blockRegion(id), "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    await writeFileAtomic(filePath, cleaned);
    return true;
  });
}

// Temp file plus rename. These files belong to the user, not to us: a truncated
// ~/.claude/CLAUDE.md is a broken Claude install and a lost profile.
async function writeFileAtomic(path: string, content: string): Promise<void> {
  const target = await resolveLink(path);
  // pid alone is not unique: one process can be writing two blocks at once.
  const tmp = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

// Follow a symlink before renaming onto it. A dotfiles repo commonly has
// ~/.claude/CLAUDE.md symlinked into it; renaming onto the link replaces the
// link with a regular file and silently detaches the user's repo.
async function resolveLink(path: string): Promise<string> {
  const resolved = await realpath(path).catch(() => null);
  if (resolved !== null) return resolved;

  // realpath refuses a link whose target does not exist yet — which is exactly
  // a fresh dotfiles checkout: the link is there, the file it points at is not.
  // Falling back to the link's own path there is how the link gets replaced by
  // a regular file on the one install where it matters most. Follow the chain
  // by hand instead, so the write lands where the link points.
  let current = path;
  for (let hops = 0; hops < 10; hops++) {
    const next = await readlink(current).catch(() => null);
    if (next === null) break;
    current = resolve(dirname(current), next);
  }
  if (current === path) return path;

  // Only the last component is allowed not to exist; the directories along the
  // way may be links of their own, and the rename has to land in the real one.
  const parent = await realpath(dirname(current)).catch(() => dirname(current));
  return join(parent, basename(current));
}
