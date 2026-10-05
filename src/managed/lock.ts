import { randomUUID } from "node:crypto";
import { open, readFile, rm, stat, utimes } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { warn } from "../util/log.js";

// A lock is stale only when its holder has stopped refreshing it. A live holder
// touches the lockfile on a heartbeat, so the staleness window can sit well
// above any plausible piece of work without making a crashed holder's lock
// linger. The two used to be equal, which meant a waiter declared a live holder
// dead at the exact moment it would otherwise have given up.
const STALE_MS = 15_000;
const HEARTBEAT_MS = 5_000;
const WAIT_MS = 5_000;
const POLL_MS = 50;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class LockBusyError extends Error {
  constructor(readonly path: string) {
    super(`could not take the lock on ${path} within ${WAIT_MS}ms`);
    this.name = "LockBusyError";
  }
}

/**
 * A lock around one file, for the files this package edits inside someone
 * else's home directory. `~/.claude/CLAUDE.md` holds a person's hand-written
 * profile and is read-modify-written by every server boot and by
 * `correct_voice`; two of those at once on an unlocked file is how a hundred
 * lines of someone's own writing disappear.
 *
 * `onBusy` decides what happens when the lock cannot be had in time, because
 * the two outcomes are not symmetric. For a file the user wrote, skipping is
 * cheap — the next boot rewrites the block and `doctor` reports it stale —
 * while writing unlocked means a read-modify-write against a live writer, so
 * those callers pass "throw". For bookkeeping the user never typed, a lost
 * record is cheaper than a lost write, so those pass "run".
 */
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
  onBusy: "throw" | "run" = "throw",
): Promise<T> {
  const lock = `${path}.agent-julia-lock`;
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + WAIT_MS;

  for (;;) {
    try {
      const handle = await open(lock, "wx");
      let named = false;
      try {
        await handle.writeFile(token, "utf8");
        named = true;
      } finally {
        await handle.close().catch(() => undefined);
        // The open above already created the lockfile. A write that fails
        // there — a full disk, a permission revoked mid-run — would otherwise
        // leave a lock behind that nobody holds and nobody releases: every
        // later writer then waits out the full staleness window before it can
        // reclaim it. Windows refuses to unlink an open file, so this runs
        // after the close, not instead of it.
        if (!named) await rm(lock, { force: true }).catch(() => undefined);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      let reclaimed = false;
      try {
        const st = await stat(lock);
        if (isStale(st.mtimeMs)) {
          const owner = await readFile(lock, "utf8").catch(() => null);
          reclaimed = await reclaim(lock, owner);
        }
      } catch (e) {
        // Only an outright disappearance justifies retrying without waiting;
        // anything else must still respect the deadline below.
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
      if (reclaimed) continue;

      if (Date.now() > deadline) {
        if (onBusy === "throw") {
          warn(`waited ${WAIT_MS}ms for ${lock}; skipping this write rather than racing the holder`);
          throw new LockBusyError(path);
        }
        warn(`waited ${WAIT_MS}ms for ${lock}; proceeding without it`);
        return fn();
      }
      await delay(POLL_MS);
    }
  }

  // Keep the lock visibly alive. Without this, work that outlasts the staleness
  // window looks dead to a waiter, which then reclaims and writes alongside it.
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(lock, now, now).catch(() => undefined);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    // Release only what is still ours. An unreadable or empty lockfile is not
    // evidence that it is: removing it would delete whatever holds it now.
    const owner = await readFile(lock, "utf8").catch(() => null);
    if (owner === token) await rm(lock, { force: true }).catch(() => undefined);
  }
}

// Both directions: a lockfile dated in the future never ages out of a
// one-sided test, so every later write would stall and then give up forever.
function isStale(mtimeMs: number): boolean {
  const age = Date.now() - mtimeMs;
  return age > STALE_MS || age < -STALE_MS;
}

// Remove a lock whose holder stopped refreshing it, one waiter at a time.
// Every waiter that finds the same dead lock decides it is stale, and deleting
// it on that decision let the first one clear it and take the lock, and a
// second, a moment later, delete that fresh lock and take it as well: two
// holders, the race the lock exists to prevent. Reclaimers now take a guard
// first, and under it look again: the lock goes only if it is still the stale
// one, with the same owner. True when the caller should try to take it now.
async function reclaim(lock: string, owner: string | null): Promise<boolean> {
  const guard = `${lock}.reclaim`;
  let handle: FileHandle;
  try {
    handle = await open(guard, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Someone else is reclaiming. Their section is a stat, a read and an
    // unlink, so a guard this old was left by a reclaimer that died in it.
    const st = await stat(guard).catch(() => null);
    if (st && isStale(st.mtimeMs)) await rm(guard, { force: true }).catch(() => undefined);
    return false;
  }
  try {
    const st = await stat(lock).catch(() => null);
    if (!st) return true;
    if (!isStale(st.mtimeMs)) return false;
    if ((await readFile(lock, "utf8").catch(() => null)) !== owner) return false;
    await rm(lock, { recursive: true, force: true });
    return true;
  } finally {
    // Closed before the unlink: Windows refuses to remove an open file.
    await handle.close().catch(() => undefined);
    await rm(guard, { force: true }).catch(() => undefined);
  }
}
