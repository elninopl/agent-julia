import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { warn } from "../util/log.js";

const STALE_MS = 60_000;
const WAIT_MS = 15_000;
const POLL_MS = 100;

// Which locks the CURRENT call chain holds. Scoped to the async context, not to
// the process: a nested acquire inside a held lock passes straight through
// (ingest takes the lock and then calls commitAll, which wants the same one),
// while a second, unrelated call in the same process waits like any other. One
// server handles several tool calls at once, so a process-wide "already held"
// would have let two concurrent ingests run together — the thing the lock is for.
const chain = new AsyncLocalStorage<Set<string>>();
// Count of locks this process holds, for the shutdown drain.
let activeHere = 0;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Serialize work across processes. Every Claude surface runs its own server
// against the same store, so two writes can interleave: an atomic mkdir is the
// mutex and a token file inside it names the holder.
//
// The token is what makes reclaiming safe. Without it, any holder that ran long
// had its lock deleted by the next waiter, and both then ran at once — the
// exact race the lock exists to prevent, now with two processes convinced they
// own it. A stale lock is only reclaimed when its token is unchanged across the
// staleness window, which a live holder refreshes.
//
// `waitMs: 0` is a try-lock: for work any one process can do on behalf of all
// of them, where finding it already taken means someone else is doing it.
export async function withStoreLock<T>(
  root: string,
  fn: () => Promise<T>,
  opts: { name?: string; waitMs?: number } = {},
): Promise<T | null> {
  const name = opts.name ?? "store";
  const waitMs = opts.waitMs ?? WAIT_MS;
  const internal = join(root, ".agent-julia");
  const lockDir = join(internal, `${name}.lock`);
  const tokenFile = join(lockDir, "owner");

  const outer = chain.getStore();
  if (outer?.has(lockDir)) return fn();

  await mkdir(internal, { recursive: true });
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + waitMs;

  for (;;) {
    let mine = false;
    try {
      await mkdir(lockDir);
      mine = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = await readOwner(tokenFile);
      const age = await lockAge(tokenFile, lockDir);
      if (age !== null && age > STALE_MS && (await reclaim(lockDir, tokenFile, owner, name))) continue;
      if (Date.now() >= deadline) {
        if (waitMs > 0) warn(`${name} lock busy — skipping this operation (the next write picks the changes up)`);
        return null;
      }
      await delay(POLL_MS);
    }
    if (!mine) continue;

    try {
      await writeFile(tokenFile, token, "utf8");
    } catch (err) {
      // A lock directory with no owner file inside it is worse than no lock at
      // all: it blocks every other process until the staleness window expires
      // and carries nothing to say who left it there. Fail having released it.
      await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
    break;
  }

  activeHere++;
  const heartbeat = setInterval(() => {
    void writeFile(tokenFile, token, "utf8").catch(() => undefined);
  }, STALE_MS / 3);
  // Do not keep the process alive for a lock.
  heartbeat.unref?.();

  const inner = new Set(outer ?? []);
  inner.add(lockDir);
  try {
    return await chain.run(inner, fn);
  } finally {
    clearInterval(heartbeat);
    activeHere--;
    // Only release what is still ours: if someone reclaimed it, removing the
    // directory would delete their lock.
    if ((await readOwner(tokenFile)) === token) {
      await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

// Remove a lock whose holder stopped refreshing it, one waiter at a time.
// Every waiter that finds the same dead lock decides it is stale. Confirming
// that the token had not changed was not enough: the first waiter removed the
// lock and took it, and a second, which had confirmed the same dead token a
// moment earlier, then removed that fresh lock and took it as well. Reclaimers
// now take a guard first and look again under it; the lock goes only if it
// still names the same holder and is still idle. True when the caller should
// try to take it now.
async function reclaim(lockDir: string, tokenFile: string, owner: string | null, name: string): Promise<boolean> {
  const guard = `${lockDir}.reclaim`;
  try {
    await mkdir(guard);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Someone else is reclaiming. Their section is a read, a stat and a
    // removal, so a guard this old was left by a reclaimer that died in it.
    const st = await stat(guard).catch(() => null);
    if (st && Date.now() - st.mtimeMs > STALE_MS) await rm(guard, { recursive: true, force: true }).catch(() => undefined);
    return false;
  }
  try {
    if ((await readOwner(tokenFile)) !== owner) return false;
    const age = await lockAge(tokenFile, lockDir);
    if (age === null) return true;
    if (age <= STALE_MS) return false;
    warn(`reclaiming a stale ${name} lock (holder ${owner ?? "unknown"}, idle ${Math.round(age / 1000)}s)`);
    await rm(lockDir, { recursive: true, force: true });
    return true;
  } finally {
    await rm(guard, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readOwner(tokenFile: string): Promise<string | null> {
  try {
    return (await readFile(tokenFile, "utf8")).trim();
  } catch {
    return null;
  }
}

// Age of the token file, which the holder rewrites on a heartbeat. The
// directory's own mtime does not move when a file inside it is rewritten, so
// stat-ing the directory would call every long-running holder stale.
async function lockAge(tokenFile: string, lockDir: string): Promise<number | null> {
  for (const target of [tokenFile, lockDir]) {
    try {
      const st = await stat(target);
      return Date.now() - st.mtimeMs;
    } catch {
      // try the next one
    }
  }
  return null;
}

// Wait until this process is not holding a store lock, or the deadline passes.
// Used on shutdown: exiting mid-ingest leaves the page written, the journal
// appended and nothing committed.
export async function waitForIdle(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (activeHere > 0) {
    if (Date.now() > deadline) return false;
    await delay(POLL_MS);
  }
  return true;
}
