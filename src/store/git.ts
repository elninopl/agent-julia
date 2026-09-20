import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { warn } from "../util/log.js";
import { withStoreLock } from "./lock.js";

const exec = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

// Every call that touches the network gets a deadline and a non-interactive
// environment. GIT_TERMINAL_PROMPT silences git's own prompt; ssh has a separate
// one, so BatchMode is what stops an ssh remote from parking the process on a
// passphrase prompt forever — on a stdio MCP server that is a Claude session
// with no memory tools, with nothing on screen to explain why.
const NETWORK_TIMEOUT_MS = 20_000;
function networkExec(): { encoding: "utf8"; timeout: number; env: NodeJS.ProcessEnv } {
  return {
    encoding: "utf8",
    timeout: NETWORK_TIMEOUT_MS,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
    },
  };
}

// Is git on PATH at all? Probed once. A product whose store is a git repo still
// has to start on a machine without git: Claude Desktop launched from Finder
// inherits launchd's PATH, and a fresh mac ships a /usr/bin/git shim that fails
// until the command line tools are installed.
let gitOnPath: boolean | null = null;
export async function gitAvailable(): Promise<boolean> {
  if (gitOnPath === null) {
    try {
      await exec("git", ["--version"], { encoding: "utf8", timeout: 5_000 });
      gitOnPath = true;
    } catch {
      gitOnPath = false;
    }
  }
  return gitOnPath;
}

// Git shares the store lock with the rest of the write path. Before, the mutex
// guarded git only: writePage, refreshIndexMd, appendLog and the index update
// all ran unlocked, so two surfaces writing at once could interleave a page
// write with another page's catalog refresh.
const withGitLock = <T>(root: string, fn: () => Promise<T>): Promise<T | null> => withStoreLock(root, fn);

// execFile rejects with a generic "Command failed" message and puts what
// actually went wrong on stderr. Reporting the wrapper's first line is how
// "fatal: couldn't find remote ref main" came out as "offline or no credentials".
function gitError(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const stderr = (e.stderr ?? "").split("\n").find((l) => l.trim());
  if (stderr) return stderr.trim();
  return (e.message ?? "").split("\n").find((l) => l.trim())?.trim() ?? "git failed";
}

// symbolic-ref, not rev-parse: a store agent-julia has just git-init-ed sits on
// an unborn branch, where rev-parse HEAD fails outright. That is exactly the
// second machine, before it has pulled anything.
export async function currentBranch(root: string): Promise<string> {
  try {
    return await git(root, ["symbolic-ref", "--short", "HEAD"]);
  } catch {
    return git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
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
  const current = await getRemoteUrl(root);
  if (current === url) return;
  if (current) {
    // An adopted repo already pointing somewhere is not ours to repoint in
    // silence. Record what it was, so the user can put it back.
    warn(`changing this store's origin from ${current} to ${url} (the previous URL is saved as remote "pre-agent-julia")`);
    await git(root, ["remote", "add", "pre-agent-julia", current]).catch(() => undefined);
    await git(root, ["remote", "set-url", "origin", url]);
    return;
  }
  await git(root, ["remote", "add", "origin", url]);
}

// Check the remote is reachable + authenticated, without pushing. Used at setup
// time so a bad URL or missing credentials surfaces immediately instead of
// silently failing on the next maintenance push.
export async function verifyRemote(root: string): Promise<{ ok: boolean; error?: string }> {
  if (!(await getRemoteUrl(root))) return { ok: false, error: "no remote configured" };
  try {
    // No --exit-code: an empty but reachable+authenticated repo (no refs yet) is
    // fine to push to; we only care that the connection and auth succeed.
    await exec("git", ["-C", root, "ls-remote", "origin"], networkExec());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: gitError(err) };
  }
}

// Push the current branch to origin. Best-effort and non-interactive: a missing
// remote, no credentials, or being offline returns false instead of hanging or
// throwing, so it never blocks a write or server startup.
export async function pushToRemote(root: string): Promise<boolean> {
  if (!isGitRepo(root)) return false;
  if (!(await getRemoteUrl(root))) return false;
  const res = await withGitLock(root, async () => {
    try {
      const branch = await currentBranch(root);
      await exec("git", ["-C", root, "push", "-u", "origin", branch], networkExec());
      return true;
    } catch (err) {
      const msg = gitError(err);
      if (/non-fast-forward|fetch first|rejected|behind/i.test(msg)) {
        warn("git push rejected — the remote has commits this machine doesn't. Pull/rebase, then push:", msg);
      } else {
        warn("git push failed (continuing):", msg);
      }
      return false;
    }
  });
  return res ?? false;
}

// Pull from origin — the other half of the two-machine story (push alone means
// machine B never sees machine A's memories). Best-effort and non-interactive:
// offline or missing credentials is a quiet skip, never a blocked startup. A
// merge conflict is aborted so the store is never left mid-merge; the user
// resolves by pulling by hand.
export async function pullFromRemote(
  root: string,
): Promise<"pulled" | "up-to-date" | "conflict" | "skipped"> {
  if (!isGitRepo(root)) return "skipped";
  if (!(await getRemoteUrl(root))) return "skipped";
  const res = await withGitLock(root, async (): Promise<"pulled" | "up-to-date" | "conflict" | "skipped"> => {
    let branch: string;
    try {
      branch = await currentBranch(root);
    } catch (err) {
      warn("git pull skipped — cannot determine the current branch:", gitError(err));
      return "skipped";
    }
    try {
      // The branch is named explicitly. Without it git needs an upstream, and a
      // store created by `git init` here has none until the first push -u
      // succeeds — which is exactly the second machine, where it has not.
      const { stdout } = await exec(
        "git",
        ["-C", root, "pull", "--no-rebase", "--no-edit", "origin", branch],
        networkExec(),
      );
      // Record the upstream so plain `git pull` works by hand from now on.
      await git(root, ["branch", `--set-upstream-to=origin/${branch}`, branch]).catch(() => undefined);
      return /Already up to date/i.test(stdout) ? "up-to-date" : "pulled";
    } catch (err) {
      if (existsSync(join(root, ".git", "MERGE_HEAD"))) {
        try {
          await git(root, ["merge", "--abort"]);
        } catch {
          // even the abort failed — leave state for the user, the warning below points there
        }
        warn(`git pull hit a merge conflict — resolve it by hand: git -C ${root} pull`);
        return "conflict";
      }
      const msg = gitError(err);
      if (/couldn't find remote ref|no such ref|Couldn't find remote ref/i.test(msg)) {
        // A remote that exists but has nothing on this branch yet: the first
        // machine has not pushed. Nothing is wrong and nothing is missing.
        return "up-to-date";
      }
      if (/refusing to merge unrelated histories/i.test(msg)) {
        warn(
          "git pull refused: this store and its remote have unrelated histories. " +
            `Reconcile them once by hand: git -C ${root} pull --allow-unrelated-histories`,
        );
        return "skipped";
      }
      warn("git pull skipped:", msg);
      return "skipped";
    }
  });
  return res ?? "skipped";
}

// Stage everything and commit. No-op when there is nothing to commit. The derived
// index is git-ignored within the store.
export async function commitAll(root: string, message: string): Promise<boolean> {
  if (!isGitRepo(root)) await ensureGitRepo(root);
  const res = await withGitLock(root, async () => {
    try {
      // A tree left mid-merge holds conflict markers in the files. Committing it
      // would write "<<<<<<< HEAD" into the user's memory and call it a save.
      for (const ref of ["MERGE_HEAD", "REVERT_HEAD", "CHERRY_PICK_HEAD"]) {
        if (existsSync(join(root, ".git", ref))) {
          warn(`not committing: the store is in the middle of a ${ref.replace("_HEAD", "").toLowerCase()}. Finish or abort it by hand.`);
          return false;
        }
      }
      // Inside the try: a transient failure here (index.lock contention) must not
      // report a write as failed when the page is already on disk and journalled.
      await git(root, ["add", "-A"]);
      const status = await git(root, ["status", "--porcelain"]);
      if (!status) return false;
      await git(root, ["commit", "-q", "-m", message]);
      return true;
    } catch (err) {
      warn("git commit failed:", (err as Error).message);
      return false;
    }
  });
  return res ?? false;
}

export interface StoreCommit {
  sha: string;
  date: string;
  subject: string;
  files: string[];
}

// The last N commits that touched the store, newest first. The product writes a
// commit on every ingest and has never once read one back; this is the reading
// half, and what `undo` picks from.
export async function listStoreCommits(root: string, limit = 10): Promise<StoreCommit[]> {
  if (!isGitRepo(root)) return [];
  try {
    const out = await git(root, [
      "log",
      `-n${limit}`,
      "--date=short",
      "--pretty=format:%H\u0001%ad\u0001%s",
      "--name-only",
    ]);
    if (!out) return [];
    return out
      .split(/\n(?=[0-9a-f]{40}\u0001)/)
      .map((block) => {
        const [head, ...rest] = block.split("\n");
        const [sha, date, subject] = (head ?? "").split("\u0001");
        return {
          sha: sha ?? "",
          date: date ?? "",
          subject: subject ?? "",
          files: rest.filter((l) => l.trim()),
        };
      })
      .filter((c) => c.sha);
  } catch (err) {
    warn("could not read the store history:", (err as Error).message);
    return [];
  }
}

// Undo one commit by recording its inverse. A revert, never a history rewrite:
// the store may already be pushed and shared with a second machine, and losing
// the record of what was undone would defeat the point of versioning it.
export async function revertCommit(
  root: string,
  sha: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!isGitRepo(root)) return { ok: false, error: "the store is not a git repository" };
  const res = await withGitLock(root, async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      const dirty = await git(root, ["status", "--porcelain"]);
      if (dirty) {
        return {
          ok: false,
          error: "the store has uncommitted changes — commit or discard them first",
        };
      }
      await git(root, ["revert", "--no-edit", sha]);
      return { ok: true };
    } catch (err) {
      try {
        await git(root, ["revert", "--abort"]);
      } catch {
        // nothing to abort, or the abort failed — the message below points the user at it
      }
      return { ok: false, error: (err as Error).message.split("\n").find((l) => l.trim()) ?? "revert failed" };
    }
  });
  return res ?? { ok: false, error: "another git operation held the lock — try again" };
}

export interface PageChange {
  sha: string;
  date: string;
  subject: string;
  added: string[];
  removed: string[];
}

// How one page changed over time, from the commits the product has been writing
// since v0.1 and had never read. Diffs are capped per commit: the point is to
// answer "when did I decide that, and what did I think before", not to print a
// patch.
export async function pageHistory(
  root: string,
  relPath: string,
  limit = 10,
  linesPerCommit = 12,
): Promise<PageChange[]> {
  if (!isGitRepo(root)) return [];
  try {
    const out = await git(root, [
      "log",
      `-n${limit}`,
      "--follow",
      "--date=short",
      "--pretty=format:%H\u0001%ad\u0001%s",
      "-p",
      "--unified=0",
      "--",
      relPath,
    ]);
    if (!out) return [];
    const changes: PageChange[] = [];
    let current: PageChange | null = null;
    for (const line of out.split("\n")) {
      const head = line.match(/^([0-9a-f]{40})\u0001([^\u0001]*)\u0001(.*)$/);
      if (head) {
        current = { sha: head[1]!, date: head[2]!, subject: head[3]!, added: [], removed: [] };
        changes.push(current);
        continue;
      }
      if (!current) continue;
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+") && current.added.length < linesPerCommit) current.added.push(line.slice(1));
      else if (line.startsWith("-") && current.removed.length < linesPerCommit) current.removed.push(line.slice(1));
    }
    return changes;
  } catch (err) {
    warn("could not read the page history:", gitError(err));
    return [];
  }
}
