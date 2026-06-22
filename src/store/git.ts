import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { warn } from "../util/log.js";

const exec = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;

// Serialize git operations across processes. Every Claude surface runs its own
// server, and two `git commit`s racing on .git/index.lock leave a write silently
// uncommitted. An atomic mkdir is the mutex; a stale lock (crashed holder) is
// reclaimed after LOCK_STALE_MS.
async function withGitLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const internal = join(root, ".agent-julia");
  const lockDir = join(internal, "git.lock");
  await mkdir(internal, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const st = await stat(lockDir);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // lock vanished between EEXIST and stat — just retry
      }
      if (Date.now() > deadline) {
        warn("git lock busy, proceeding without it");
        return fn();
      }
      await delay(100);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

export function isGitRepo(root: string): boolean {
  return existsSync(join(root, ".git"));
}

// Initialize a git repo if the memory dir isn't one yet. Local identity is set so
// commits work even when the user has no global git config.
export async function ensureGitRepo(root: string): Promise<void> {
  if (isGitRepo(root)) return;
  await git(root, ["init", "-q"]);
  try {
    await git(root, ["config", "user.name"]);
  } catch {
    await git(root, ["config", "user.name", "agent-julia"]);
  }
  try {
    await git(root, ["config", "user.email"]);
  } catch {
    await git(root, ["config", "user.email", "agent-julia@localhost"]);
  }
}

export async function getRemoteUrl(root: string): Promise<string | null> {
  try {
    return await git(root, ["remote", "get-url", "origin"]);
  } catch {
    return null;
  }
}

// Point origin at `url`, adding or updating it as needed.
export async function setRemoteUrl(root: string, url: string): Promise<void> {
  if (!isGitRepo(root)) await ensureGitRepo(root);
  if (await getRemoteUrl(root)) await git(root, ["remote", "set-url", "origin", url]);
  else await git(root, ["remote", "add", "origin", url]);
}

// Check the remote is reachable + authenticated, without pushing. Used at setup
// time so a bad URL or missing credentials surfaces immediately instead of
// silently failing on the next maintenance push.
export async function verifyRemote(root: string): Promise<{ ok: boolean; error?: string }> {
  if (!(await getRemoteUrl(root))) return { ok: false, error: "no remote configured" };
  try {
    // No --exit-code: an empty but reachable+authenticated repo (no refs yet) is
    // fine to push to; we only care that the connection and auth succeed.
    await exec("git", ["-C", root, "ls-remote", "origin"], {
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message.split("\n")[0] };
  }
}

// Push the current branch to origin. Best-effort and non-interactive: a missing
// remote, no credentials, or being offline returns false instead of hanging or
// throwing, so it never blocks a write or server startup.
export async function pushToRemote(root: string): Promise<boolean> {
  if (!isGitRepo(root)) return false;
  if (!(await getRemoteUrl(root))) return false;
  return withGitLock(root, async () => {
    try {
      const branch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
      await exec("git", ["-C", root, "push", "-u", "origin", branch], {
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return true;
    } catch (err) {
      const msg = (err as Error).message.split("\n").find((l) => l.trim()) ?? "";
      if (/non-fast-forward|fetch first|rejected|behind/i.test(msg)) {
        warn("git push rejected — the remote has commits this machine doesn't. Pull/rebase, then push:", msg);
      } else {
        warn("git push failed (continuing):", msg);
      }
      return false;
    }
  });
}

// Stage everything and commit. No-op when there is nothing to commit. The derived
// index is git-ignored within the store.
export async function commitAll(root: string, message: string): Promise<boolean> {
  if (!isGitRepo(root)) await ensureGitRepo(root);
  return withGitLock(root, async () => {
    await git(root, ["add", "-A"]);
    try {
      const status = await git(root, ["status", "--porcelain"]);
      if (!status) return false;
      await git(root, ["commit", "-q", "-m", message]);
      return true;
    } catch (err) {
      warn("git commit failed:", (err as Error).message);
      return false;
    }
  });
}
