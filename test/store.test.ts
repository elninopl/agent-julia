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
