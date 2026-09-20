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
