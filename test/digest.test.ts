import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Indexer } from "../src/index/indexer.js";
import { EmbeddingProvider } from "../src/index/embeddings.js";
import { buildProposals } from "../src/maintenance/proposals.js";
import { runMaintenance } from "../src/maintenance/maintenance.js";
import { archivePage, readPage, writePage } from "../src/store/markdown.js";
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

describe("near-duplicate proposals over chunked pages", () => {
  // Every chunk embeds to the same vector: the worst case for a comparison
  // that treats chunks as pages.
  const flat: EmbeddingProvider = {
    id: "fake-flat",
    dims: 3,
    enabled: true,
    async embed(texts) {
      return texts.map(() => [1, 0, 0]);
    },
    async embedQuery() {
      return [1, 0, 0];
    },
  };
  const longPage = (topic: string) =>
    Array.from({ length: 4 }, (_, i) => `## ${topic} ${i}\n\n${"Notes on the same subject. ".repeat(12)}`).join("\n\n");

  it("never pairs a page with itself, lists each pair once, and keeps only the closest few", async () => {
    const { paths, config } = fresh();
    for (let n = 0; n < 6; n++) await writePage(paths, `page-${n}`, longPage(`part-${n}`), {});
    const idx = Indexer.open(paths, config, flat);
    try {
      await idx.sync();
      const { nearDuplicates } = await buildProposals(paths, idx);
      expect(nearDuplicates.every((d) => d.a !== d.b)).toBe(true);
      const keys = nearDuplicates.map((d) => [d.a, d.b].sort().join("+"));
      expect(new Set(keys).size).toBe(keys.length);
      // 6 pages are 15 pairs, all identical; the digest shows ten.
      expect(nearDuplicates).toHaveLength(10);
    } finally {
      idx.close();
    }
  });

  it("ignores vectors from another model", async () => {
    const { paths, config } = fresh();
    await writePage(paths, "one", "alpha", {});
    await writePage(paths, "two", "beta", {});
    let idx = Indexer.open(paths, config, flat);
    await idx.sync();
    idx.close();
    idx = Indexer.open(paths, config, { ...flat, id: "fake-flat-v2" });
    try {
      expect((await buildProposals(paths, idx)).nearDuplicates).toEqual([]);
    } finally {
      idx.close();
    }
  });
});

describe("archivePage", () => {
  it("moves the page out of pages/ into archive/", async () => {
    const { paths } = fresh();
    await writePage(paths, "retired", "old stuff", {});
    expect(await archivePage(paths, "retired")).toBeTruthy();
    expect(existsSync(join(paths.pagesDir, "retired.md"))).toBe(false);
    expect(existsSync(join(paths.archiveDir, "retired.md"))).toBe(true);
    expect(await archivePage(paths, "retired")).toBeNull();
  });
});

describe("archive keeps what it was given", () => {
  it("does not overwrite an earlier page archived under the same id, and reads back", async () => {
    // The one directory whose whole purpose is keeping things used to overwrite
    // in place: archiving a second "notes" destroyed the first one.
    const dir = mkdtempSync(join(tmpdir(), "aj-arch-"));
    const paths = storePaths(dir);

    await writePage(paths, "notes", "---\nupdated: '2026-01-01'\n---\n\nfirst version", {});
    const a = await archivePage(paths, "notes");
    await writePage(paths, "notes", "second version", {});
    const b = await archivePage(paths, "notes");

    expect(a).not.toBe(b);
    expect(readFileSync(a!, "utf8")).toContain("first version");
    expect(readFileSync(b!, "utf8")).toContain("second version");

    // An archived page is addressable again.
    const back = await readPage(paths, "archive/notes");
    expect(back).not.toBeNull();
    expect(back!.body).toContain("version");
  });
});
