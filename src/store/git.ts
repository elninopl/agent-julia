import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { warn } from "../util/log.js";

const exec = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
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

// Stage everything and commit. No-ops cleanly when there is nothing to commit, so
// callers never have to guard. The derived index is git-ignored within the store.
export async function commitAll(root: string, message: string): Promise<boolean> {
  if (!isGitRepo(root)) await ensureGitRepo(root);
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
}
