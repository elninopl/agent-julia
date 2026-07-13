import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Indexer } from "../src/index/indexer.js";
import { EmbeddingProvider } from "../src/index/embeddings.js";
import { buildProposals } from "../src/maintenance/proposals.js";
import { runMaintenance } from "../src/maintenance/maintenance.js";
import { archivePage, writePage } from "../src/store/markdown.js";
import { storePaths } from "../src/store/paths.js";
import { ConfigSchema } from "../src/config/schema.js";

// Two texts sharing the "twin" keyword embed almost identically; others differ.
function vec(text: string): number[] {
  const t = text.toLowerCase();
  const v = [t.includes("twin") ? 1 : 0.01, t.includes("boat") ? 1 : 0.01, t.length % 7 === 0 ? 0.4 : 0.2];
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}
const provider: EmbeddingProvider = {
  id: "fake-digest",
  dims: 3,
  enabled: true,
  async embed(texts) {
    return texts.map(vec);
  },
  async embedQuery(t) {
    return vec(t);
  },
};

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "aj-digest-"));
  const config = ConfigSchema.parse({ memoryDir: dir, git: false, embedding: { provider: "local" } });
  return { paths: storePaths(dir), config };
}

describe("weekly digest proposals", () => {
  it("finds duplicates, stale pages, orphans, unlinked and oversized pages", async () => {
    const { paths, config } = fresh();
    await writePage(paths, "twin-one", "twin twin twin story", {});
    await writePage(paths, "twin-two", "twin twin twin story retold", {});
    // writePage stamps `updated` with today, so a genuinely stale page has to
    // be written straight to disk, like a hand-edited file.
    mkdirSync(paths.pagesDir, { recursive: true });
    writeFileSync(
      join(paths.pagesDir, "old-fact.md"),
      "---\ntitle: Old fact\nupdated: 2020-01-01\n---\n\nlinks to [[twin-one]] and [[ghost-page]]\n",
      "utf8",
    );
    await writePage(paths, "loner", "boat boat boat", {});
    await writePage(paths, "giant", "word ".repeat(2000), {});

    const idx = Indexer.open(paths, config, provider);
    await idx.sync();
    const p = await buildProposals(paths, idx);

    expect(p.nearDuplicates.some((d) => [d.a, d.b].sort().join("+") === "twin-one+twin-two")).toBe(true);
    expect(p.staleCandidates.map((s) => s.id)).toContain("old-fact");
    expect(p.orphanLinks).toContainEqual({ from: "old-fact", to: "ghost-page" });
    expect(p.unlinkedPages).toContain("loner");
    expect(p.unlinkedPages).not.toContain("twin-one"); // linked from old-fact
    expect(p.oversizedPages.map((o) => o.id)).toContain("giant");
    idx.close();
  });

  it("maintenance returns proposals only in interactive mode", async () => {
    const { paths, config } = fresh();
    await writePage(paths, "solo", "just a page", {});
    const idx = Indexer.open(paths, config, provider);

    const auto = await runMaintenance(paths, idx, config, "auto");
    expect(auto.proposals).toBeNull();

    const digest = await runMaintenance(paths, idx, config, "interactive");
    expect(digest.proposals).not.toBeNull();
    expect(digest.proposals!.unlinkedPages).toContain("solo");
    idx.close();
  });
});

describe("archivePage", () => {
  it("moves the page out of pages/ into archive/", async () => {
    const { paths } = fresh();
    await writePage(paths, "retired", "old stuff", {});
    expect(await archivePage(paths, "retired")).toBe(true);
    expect(existsSync(join(paths.pagesDir, "retired.md"))).toBe(false);
    expect(existsSync(join(paths.archiveDir, "retired.md"))).toBe(true);
    expect(await archivePage(paths, "retired")).toBe(false);
  });
});
