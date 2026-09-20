import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Indexer } from "../src/index/indexer.js";
import { storePaths } from "../src/store/paths.js";
import { ingest } from "../src/store/ingest.js";
import { listPages, readPage, writePage } from "../src/store/markdown.js";
import { listStoreCommits, pushToRemote, revertCommit, setRemoteUrl } from "../src/store/git.js";
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

  it("pulls onto a machine that agent-julia set up itself, with no upstream tracking", async () => {
    // The real second machine: the wizard runs `git init` and points it at the
    // remote. Nothing ever set an upstream, so `git pull origin` with no branch
    // failed with "did not specify a branch" — reported to the user as
    // "offline or no credentials", on every single startup, forever.
    const { pullFromRemote, setRemoteUrl, ensureGitRepo, pushToRemote } = await import("../src/store/git.js");
    const { writePage } = await import("../src/store/markdown.js");
    const { storePaths } = await import("../src/store/paths.js");
    const { existsSync: fsExists } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");

    const bare = mkdtempSync(join(tmpdir(), "aj-bare-"));
    execFileSync("git", ["init", "--bare", "-q", bare]);

    const a = mkdtempSync(join(tmpdir(), "aj-a-"));
    await ensureGitRepo(a);
    await writePage(storePaths(a), "shared-fact", "written on machine A", {});
    execFileSync("git", ["-C", a, "add", "-A"]);
    execFileSync("git", ["-C", a, "commit", "-q", "-m", "from A"]);
    await setRemoteUrl(a, bare);
    expect(await pushToRemote(a)).toBe(true);

    // Machine B exactly as the wizard makes it: init, then a remote. No clone.
    const b = mkdtempSync(join(tmpdir(), "aj-b-"));
    await ensureGitRepo(b);
    await setRemoteUrl(b, bare);

    expect(await pullFromRemote(b)).toBe("pulled");
    expect(fsExists(join(b, "pages", "shared-fact.md"))).toBe(true);
    expect(await pullFromRemote(b)).toBe("up-to-date");
  });

  it("treats a remote with nothing on this branch yet as up-to-date, not as an error", async () => {
    const { pullFromRemote, setRemoteUrl, ensureGitRepo } = await import("../src/store/git.js");
    const { execFileSync } = await import("node:child_process");

    const bare = mkdtempSync(join(tmpdir(), "aj-bare-"));
    execFileSync("git", ["init", "--bare", "-q", bare]);
    const b = mkdtempSync(join(tmpdir(), "aj-b-"));
    await ensureGitRepo(b);
    await setRemoteUrl(b, bare);

    // Nobody has pushed anything yet. That is a new setup, not a failure.
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

describe("front matter is data, never code", () => {
  it("refuses a page whose front matter is javascript, and keeps reading the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-fm-"));
    const paths = storePaths(dir);
    mkdirSync(paths.pagesDir, { recursive: true });
    const marker = join(dir, "pwned.txt");

    // gray-matter's `javascript` engine parses with eval(). This is exactly what
    // arrives from `git pull`, from adopting someone's notes folder, or from a
    // model pasting web content into `ingest`.
    writeFileSync(
      join(paths.pagesDir, "poisoned.md"),
      `---js\n{ title: (require("fs").writeFileSync(${JSON.stringify(marker)}, "x"), "ok") }\n---\n\nbody\n`,
      "utf8",
    );
    writeFileSync(join(paths.pagesDir, "healthy.md"), "---\ntitle: healthy\n---\n\nbody\n", "utf8");

    expect(await readPage(paths, "poisoned")).toBeNull();
    expect(existsSync(marker)).toBe(false);

    // One bad file must not take the store down with it.
    expect((await listPages(paths)).map((p) => p.id)).toEqual(["healthy"]);
  });

  it("refuses javascript front matter arriving through ingest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-fm2-"));
    const paths = storePaths(dir);
    const marker = join(dir, "pwned2.txt");
    await expect(
      writePage(paths, "evil", `---js\n{ title: (require("fs").writeFileSync(${JSON.stringify(marker)}, "x"), "ok") }\n---\n\nbody\n`, {}),
    ).rejects.toThrow(/scripting language/i);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("a save must not silently destroy the page it was meant to extend", () => {
  function store() {
    const dir = mkdtempSync(join(tmpdir(), "aj-write-"));
    return storePaths(dir);
  }

  const established = [
    "Fact one: the weekly review is on Mondays.",
    "Fact two: billing runs on Stripe.",
    "Fact three: the staging database is reset nightly.",
    "Fact four: deploys go out through Elastic Beanstalk.",
  ].join("\n\n");

  it("appends under what is already there", async () => {
    const paths = store();
    await writePage(paths, "prive", established, {});
    const w = await writePage(paths, "prive", "Fact five: the weekly moved to Tuesdays.", { mode: "append" });

    const page = await readPage(paths, "prive");
    expect(page!.body).toContain("Fact one");
    expect(page!.body).toContain("Fact five");
    expect(w.linesRemoved).toBe(0);
    expect(w.linesAdded).toBeGreaterThan(0);
  });

  it("refuses a replace that throws the page away, and says how to proceed", async () => {
    const paths = store();
    await writePage(paths, "prive", established, {});
    await expect(
      writePage(paths, "prive", "Fact five: the weekly moved to Tuesdays.", {}),
    ).rejects.toThrow(/mode "append"|confirm: true/);

    // The page is untouched by the refusal.
    expect((await readPage(paths, "prive"))!.body).toContain("Fact one");
  });

  it("carries out the same write when it is confirmed", async () => {
    const paths = store();
    await writePage(paths, "prive", established, {});
    const w = await writePage(paths, "prive", "Deliberate rewrite.", { confirm: true });
    expect((await readPage(paths, "prive"))!.body).toBe("Deliberate rewrite.");
    expect(w.linesRemoved).toBeGreaterThan(0);
  });

  it("refuses an empty page", async () => {
    const paths = store();
    await writePage(paths, "prive", established, {});
    await expect(writePage(paths, "prive", "   ", {})).rejects.toThrow(/empty/i);
    expect((await readPage(paths, "prive"))!.body).toContain("Fact one");
  });

  it("keeps front matter the writer never mentioned", async () => {
    const paths = store();
    await writePage(paths, "prive", "---\ntitle: Privé\ntags: [game, couples]\nowner: martyna\n---\n\nbody one", {});
    // A read-modify-write cycle that only carries the body back.
    await writePage(paths, "prive", "body one\n\nbody two", { confirm: true });

    const page = await readPage(paths, "prive");
    expect(page!.frontmatter.title).toBe("Privé");
    expect((page!.frontmatter as Record<string, unknown>).tags).toEqual(["game", "couples"]);
    expect((page!.frontmatter as Record<string, unknown>).owner).toBe("martyna");
  });

  it("reports the size delta so a shrinking write is visible", async () => {
    const paths = store();
    await writePage(paths, "prive", established, {});
    const w = await writePage(paths, "prive", "Fact one: the weekly review is on Mondays.\n\nFact two: billing runs on Stripe.", { confirm: true });
    expect(w.bytesBefore).toBeGreaterThan(w.bytesAfter);
    expect(w.linesRemoved).toBeGreaterThan(0);
  });
});

describe("undo", () => {
  it("reverts the commit that destroyed a page, and the content comes back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-undo-"));
    const paths = storePaths(dir);
    const cfg = ConfigSchema.parse({ memoryDir: dir, search: "fts" });
    await migrate(cfg);
    const indexer = Indexer.open(paths, cfg);
    try {
      await ingest(paths, indexer, "prive", "Fact one.\n\nFact two.\n\nFact three.\n\nFact four.", { git: true });
      await ingest(paths, indexer, "prive", "Only this line survives.", { git: true, confirm: true });
      expect((await readPage(paths, "prive"))!.body).toBe("Only this line survives.");

      const commits = await listStoreCommits(dir, 5);
      expect(commits[0]!.subject).toMatch(/Update memory: prive/);
      expect(commits[0]!.files).toContain("pages/prive.md");

      const { ok } = await revertCommit(dir, commits[0]!.sha);
      expect(ok).toBe(true);
      expect((await readPage(paths, "prive"))!.body).toContain("Fact four.");
    } finally {
      indexer.close();
    }
  });
});
