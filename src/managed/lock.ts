import { randomUUID } from "node:crypto";
import { open, readFile, rm, stat, utimes } from "node:fs/promises";
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
      try {
        await handle.writeFile(token, "utf8");
      } finally {
        await handle.close();
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      let reclaimed = false;
      try {
        const st = await stat(lock);
        const age = Date.now() - st.mtimeMs;
        // Both directions: a lockfile dated in the future never ages out of a
        // one-sided test, so every later write would stall and then give up
        // forever.
        if (age > STALE_MS || age < -STALE_MS) {
          // Confirm nothing moved before taking it from whoever holds it.
          // Reclaiming blind hands the lock to two holders at once, which is
          // the race the lock exists to prevent.
          const owner = await readFile(lock, "utf8").catch(() => null);
          await delay(POLL_MS);
          if ((await readFile(lock, "utf8").catch(() => null)) === owner) {
            await rm(lock, { recursive: true, force: true });
            reclaimed = true;
          }
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
