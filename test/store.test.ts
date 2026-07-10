import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Indexer } from "../src/index/indexer.js";
import { storePaths } from "../src/store/paths.js";
import { ingest } from "../src/store/ingest.js";
import { pushToRemote, setRemoteUrl } from "../src/store/git.js";
import { migrate } from "../src/migrations/runner.js";
import { ConfigSchema } from "../src/config/schema.js";

describe("git gating on ingest", () => {
  let close: (() => void) | null = null;
  afterEach(() => close?.());

  async function run(git: boolean) {
    const dir = mkdtempSync(join(tmpdir(), "aj-git-"));
    const cfg = ConfigSchema.parse({ memoryDir: dir, git, search: "fts" });
    await migrate(cfg);
    const paths = storePaths(dir);
    const indexer = Indexer.open(paths, cfg);
    close = () => indexer.close();
    const res = await ingest(paths, indexer, "note", "a durable fact", { git: cfg.git });
    return { dir, res };
  }

  it("commits when git is on", async () => {
    const { dir, res } = await run(true);
    expect(res.committed).toBe(true);
    expect(existsSync(join(dir, ".git"))).toBe(true);
  });

  it("does not commit or create a repo when git is off", async () => {
    const { dir, res } = await run(false);
    expect(res.committed).toBe(false);
    expect(existsSync(join(dir, ".git"))).toBe(false);
    // the page is still written
    expect(existsSync(join(dir, "pages", "note.md"))).toBe(true);
  });

  it("pushes commits to a configured remote", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-git-"));
    const bare = mkdtempSync(join(tmpdir(), "aj-bare-"));
    execFileSync("git", ["init", "--bare", "-q", bare]);
    const cfg = ConfigSchema.parse({ memoryDir: dir, git: true, search: "fts" });
    await migrate(cfg);
    const paths = storePaths(dir);
    const indexer = Indexer.open(paths, cfg);
    close = () => indexer.close();
    await ingest(paths, indexer, "note", "a durable fact", { git: true });

    await setRemoteUrl(dir, bare);
    expect(await pushToRemote(dir)).toBe(true);
    const log = execFileSync("git", ["-C", bare, "log", "--oneline"], { encoding: "utf8" });
    expect(log.trim().length).toBeGreaterThan(0);
  });

  it("auto-pushes on ingest when enabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-git-"));
    const bare = mkdtempSync(join(tmpdir(), "aj-bare-"));
    execFileSync("git", ["init", "--bare", "-q", bare]);
    const cfg = ConfigSchema.parse({ memoryDir: dir, git: true, search: "fts" });
    await migrate(cfg);
    const paths = storePaths(dir);
    const indexer = Indexer.open(paths, cfg);
    close = () => indexer.close();
    await setRemoteUrl(dir, bare);

    const res = await ingest(paths, indexer, "note", "a durable fact", { git: true, autoPush: true });
    expect(res.pushed).toBe(true);
    const log = execFileSync("git", ["-C", bare, "log", "--oneline"], { encoding: "utf8" });
    expect(log).toContain("Update memory: note");
  });
});

describe("latestStoreMtime", () => {
  it("rises when a page is deleted, so maintenance is not skipped", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { storePaths } = await import("../src/store/paths.js");
    const { writePage, latestStoreMtime } = await import("../src/store/markdown.js");

    const dir = mkdtempSync(join(tmpdir(), "aj-mtime-"));
    const paths = storePaths(dir);
    await writePage(paths, "keep", "stays", {});
    await writePage(paths, "doomed", "goes away", {});
    const before = await latestStoreMtime(paths);

    await new Promise((r) => setTimeout(r, 20));
    await rm(join(paths.pagesDir, "doomed.md"));
    const after = await latestStoreMtime(paths);
    expect(after).toBeGreaterThan(before);
  });
});

describe("pullFromRemote — two-machine sync", () => {
  it("brings machine A's pushed memories onto machine B", async () => {
    const { pullFromRemote, setRemoteUrl, ensureGitRepo, pushToRemote } = await import("../src/store/git.js");
    const { writePage } = await import("../src/store/markdown.js");
    const { storePaths } = await import("../src/store/paths.js");
    const { readFileSync, existsSync: fsExists } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");

    const bare = mkdtempSync(join(tmpdir(), "aj-bare-"));
    execFileSync("git", ["init", "--bare", "-q", bare]);

    // Machine A: write and push.
    const a = mkdtempSync(join(tmpdir(), "aj-a-"));
    await ensureGitRepo(a);
    const pathsA = storePaths(a);
    await writePage(pathsA, "shared-fact", "written on machine A", {});
    execFileSync("git", ["-C", a, "add", "-A"]);
    execFileSync("git", ["-C", a, "commit", "-q", "-m", "from A"]);
    await setRemoteUrl(a, bare);
    expect(await pushToRemote(a)).toBe(true);

    // Machine B: same remote, empty store — pull.
    const b = mkdtempSync(join(tmpdir(), "aj-b-"));
    execFileSync("git", ["clone", "-q", bare, b]);
    // drop the clone's content to simulate being behind, then reset to an old state
    execFileSync("git", ["-C", b, "reset", "-q", "--hard", "HEAD"]);
    // A pushes one more page B doesn't have:
    await writePage(pathsA, "newer-fact", "second write on A", {});
    execFileSync("git", ["-C", a, "add", "-A"]);
    execFileSync("git", ["-C", a, "commit", "-q", "-m", "more from A"]);
    expect(await pushToRemote(a)).toBe(true);

    expect(await pullFromRemote(b)).toBe("pulled");
    expect(fsExists(join(b, "pages", "newer-fact.md"))).toBe(true);
    expect(readFileSync(join(b, "pages", "newer-fact.md"), "utf8")).toContain("second write on A");
    expect(await pullFromRemote(b)).toBe("up-to-date");
  });

  it("aborts a conflicted merge and leaves the store clean", async () => {
    const { pullFromRemote, setRemoteUrl, ensureGitRepo, pushToRemote } = await import("../src/store/git.js");
    const { writeFileSync: wf } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");

    const bare = mkdtempSync(join(tmpdir(), "aj-bare-"));
    execFileSync("git", ["init", "--bare", "-q", bare]);

    const a = mkdtempSync(join(tmpdir(), "aj-a-"));
    await ensureGitRepo(a);
    wf(join(a, "clash.md"), "base\n", "utf8");
    execFileSync("git", ["-C", a, "add", "-A"]);
    execFileSync("git", ["-C", a, "commit", "-q", "-m", "base"]);
    await setRemoteUrl(a, bare);
    expect(await pushToRemote(a)).toBe(true);

    const b = mkdtempSync(join(tmpdir(), "aj-b-"));
    execFileSync("git", ["clone", "-q", bare, b]);
    // A fresh clone has no committer identity on CI runners.
    execFileSync("git", ["-C", b, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", b, "config", "user.name", "Test"]);

    // Diverge: both edit the same line.
    wf(join(a, "clash.md"), "version A\n", "utf8");
    execFileSync("git", ["-C", a, "commit", "-q", "-am", "A edit"]);
    expect(await pushToRemote(a)).toBe(true);
    wf(join(b, "clash.md"), "version B\n", "utf8");
    execFileSync("git", ["-C", b, "commit", "-q", "-am", "B edit"]);

    expect(await pullFromRemote(b)).toBe("conflict");
    // No merge in progress, B's own version intact.
    const status = execFileSync("git", ["-C", b, "status", "--porcelain"], { encoding: "utf8" });
    expect(status.trim()).toBe("");
  });
});

describe("relatedPages", () => {
  it("returns forward links and backlinks", async () => {
    const { relatedPages } = await import("../src/store/markdown.js");
    const { writePage } = await import("../src/store/markdown.js");
    const dir = mkdtempSync(join(tmpdir(), "aj-rel-"));
    const paths = storePaths(dir);
    await writePage(paths, "hub", "links to [[spoke-a]] and [[Spoke-B|label]]", {});
    await writePage(paths, "spoke-a", "no links here", {});
    await writePage(paths, "spoke-b", "points back at [[hub]]", {});

    const hub = await relatedPages(paths, "hub");
    expect(hub.links.sort()).toEqual(["spoke-a", "spoke-b"]);
    expect(hub.backlinks).toEqual(["spoke-b"]);

    const spokeA = await relatedPages(paths, "spoke-a");
    expect(spokeA.links).toEqual([]);
    expect(spokeA.backlinks).toEqual(["hub"]);
  });
});
