import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Indexer } from "../src/index/indexer.js";
import { storePaths, pageFilePath } from "../src/store/paths.js";
import { writePage } from "../src/store/markdown.js";
import { ConfigSchema } from "../src/config/schema.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "aj-idx-"));
  const paths = storePaths(dir);
  const cfg = ConfigSchema.parse({ memoryDir: dir, search: "fts" });
  const indexer = Indexer.open(paths, cfg);
  return { dir, paths, indexer };
}

describe("incremental sync", () => {
  let close: (() => void) | null = null;
  afterEach(() => close?.());

  it("adds new pages, detects hand-edits by hash, and drops deleted pages", async () => {
    const { paths, indexer } = setup();
    close = () => indexer.close();

    await writePage(paths, "alpha", "first page about reddit marketing", {});
    await writePage(paths, "beta", "second page about stripe billing", {});

    let r = await indexer.sync();
    expect(r.added).toBe(2);
    expect(r.updated).toBe(0);
    expect((await indexer.search("reddit", 5)).map((h) => h.id)).toContain("alpha");

    // No-op sync: nothing changed, so no work.
    r = await indexer.sync();
    expect(r).toEqual({ added: 0, updated: 0, removed: 0 });

    // Hand-edit the markdown file directly (not via ingest) — sync must catch it.
    writeFileSync(
      pageFilePath(paths.root, "alpha"),
      "---\ntitle: alpha\n---\n\nrewritten to talk about kubernetes\n",
      "utf8",
    );
    r = await indexer.sync();
    expect(r.updated).toBe(1);
    expect((await indexer.search("kubernetes", 5)).map((h) => h.id)).toContain("alpha");
    expect((await indexer.search("reddit", 5)).map((h) => h.id)).not.toContain("alpha");

    // Delete a page file -> sync removes it from the index.
    writeFileSync(pageFilePath(paths.root, "beta"), "", "utf8");
    const { rmSync } = await import("node:fs");
    rmSync(pageFilePath(paths.root, "beta"));
    r = await indexer.sync();
    expect(r.removed).toBe(1);
    expect((await indexer.search("stripe", 5)).map((h) => h.id)).not.toContain("beta");
  });
});
