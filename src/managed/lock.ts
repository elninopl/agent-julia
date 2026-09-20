import { randomUUID } from "node:crypto";
import { open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { warn } from "../util/log.js";

const STALE_MS = 5_000;
const WAIT_MS = 5_000;
const POLL_MS = 50;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A lock around one file, for the files this package edits inside someone else's
// home directory. ~/.claude/CLAUDE.md holds a user's hand-written profile and is
// read-modify-written by every server boot and now by correct_voice too; two of
// those at once on an unlocked file is how 180 lines of someone's own writing
// disappear. Exclusive create is the mutex; a lock older than the staleness
// window belonged to a process that died.
export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.agent-julia-lock`;
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lock, "wx");
      await handle.writeFile(token, "utf8");
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const st = await stat(lock);
        if (Date.now() - st.mtimeMs > STALE_MS) {
          // Confirm nothing moved before taking it from whoever holds it:
          // reclaiming blind hands the lock to two holders at once, which is the
          // race the lock exists to prevent.
          const owner = await readFile(lock, "utf8").catch(() => "");
          await delay(POLL_MS);
          if ((await readFile(lock, "utf8").catch(() => "")) === owner) {
            await rm(lock, { force: true });
          }
        }
      } catch (e) {
        // Only an outright disappearance justifies retrying without waiting;
        // anything else must still respect the deadline below.
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
      if (Date.now() > deadline) {
        // Proceeding unlocked is worse than being late, but never finishing is
        // worse than both: this path runs on every server boot.
        warn(`waited ${WAIT_MS}ms for ${lock}; proceeding without it`);
        return fn();
      }
      await delay(POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    // Release only what is still ours: if a waiter reclaimed it as stale,
    // removing the file would delete their lock.
    const owner = await readFile(lock, "utf8").catch(() => "");
    if (owner === "" || owner === token) await rm(lock, { force: true }).catch(() => undefined);
  }
}
