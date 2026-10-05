import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { waitForIdle, withStoreLock } from "../src/store/lock.js";
import { storePaths } from "../src/store/paths.js";
import { writePage, writeFileAtomic, readPage } from "../src/store/markdown.js";
import { ingest } from "../src/store/ingest.js";
import { Indexer } from "../src/index/indexer.js";
import { ConfigSchema } from "../src/config/schema.js";

describe("the store lock", () => {
  it("serializes work and lets a nested acquire through", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-lock-"));
    const order: string[] = [];

    const slow = withStoreLock(dir, async () => {
      order.push("outer:start");
      // A nested acquire in the same process must not deadlock: ingest takes the
      // lock and then calls commitAll, which wants the same one.
      await withStoreLock(dir, async () => order.push("nested"));
      await new Promise((r) => setTimeout(r, 60));
      order.push("outer:end");
    });
    const fast = (async () => {
      await new Promise((r) => setTimeout(r, 10));
      return withStoreLock(dir, async () => order.push("second"));
    })();

    await Promise.all([slow, fast]);
    expect(order).toEqual(["outer:start", "nested", "outer:end", "second"]);
  });

  it("releases the lock and reports idle afterwards", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-lock2-"));
    await withStoreLock(dir, async () => undefined);
    expect(existsSync(join(dir, ".agent-julia", "store.lock"))).toBe(false);
    expect(await waitForIdle(100)).toBe(true);
  });

  it("does not interleave two concurrent ingests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-lock3-"));
    const paths = storePaths(dir);
    const cfg = ConfigSchema.parse({ memoryDir: dir, search: "fts", git: false });
    const indexer = Indexer.open(paths, cfg);
    try {
      await writePage(paths, "shared", "base line", {});
      await Promise.all([
        ingest(paths, indexer, "shared", "from A", { git: false, mode: "append" }),
        ingest(paths, indexer, "shared", "from B", { git: false, mode: "append" }),
      ]);
      const body = (await readPage(paths, "shared"))!.body;
      // Both appends land; neither read-modify-write clobbers the other.
      expect(body).toContain("base line");
      expect(body).toContain("from A");
      expect(body).toContain("from B");
    } finally {
      indexer.close();
    }
  });

  it("lets an ingest through while another server holds the boot refresh", async () => {
    // The refresh used to run under the store lock, so a session saving a fact
    // while another one booted waited out the refresh and could lose the write.
    const dir = mkdtempSync(join(tmpdir(), "aj-lock4-"));
    const paths = storePaths(dir);
    const cfg = ConfigSchema.parse({ memoryDir: dir, search: "fts", git: false });
    const indexer = Indexer.open(paths, cfg);
    try {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const refresh = withStoreLock(dir, () => held, { name: "refresh" });
      await new Promise((r) => setTimeout(r, 20));

      const started = Date.now();
      await ingest(paths, indexer, "note", "saved during a boot", { git: false });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect((await readPage(paths, "note"))!.body).toContain("saved during a boot");

      release();
      await refresh;
    } finally {
      indexer.close();
    }
  });
});

describe("page writes are atomic", () => {
  it("leaves no temp file behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-atomic-"));
    const paths = storePaths(dir);
    await writePage(paths, "page", "content", {});
    expect(readdirSync(paths.pagesDir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("keeps the old file when the write fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-atomic2-"));
    const paths = storePaths(dir);
    await writePage(paths, "page", "original content", {});
    // A directory where the temp file wants to go: the rename cannot happen.
    await expect(writeFileAtomic(join(paths.pagesDir), "nonsense")).rejects.toThrow();
    expect((await readPage(paths, "page"))!.body).toBe("original content");
  });
});
