import { open, rm, stat } from "node:fs/promises";
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
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lock, "wx");
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const st = await stat(lock);
        if (Date.now() - st.mtimeMs > STALE_MS) {
          await rm(lock, { force: true });
          continue;
        }
      } catch {
        continue; // it vanished between the two calls
      }
      if (Date.now() > deadline) {
        // Proceeding unlocked is worse than being late, but never finishing is
        // worse than both: this path runs on every server boot.
        warn(`waited ${WAIT_MS}ms for ${lock}; proceeding without it`);
        break;
      }
      await delay(POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true }).catch(() => undefined);
  }
}
