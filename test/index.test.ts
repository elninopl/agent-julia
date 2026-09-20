import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Indexer } from "../src/index/indexer.js";
import { allIndexedIds, getMeta, setMeta } from "../src/index/db.js";
import { storePaths, pageFilePath } from "../src/store/paths.js";
import { todayISO, writePage } from "../src/store/markdown.js";
import { ConfigSchema } from "../src/config/schema.js";

function setup(language = "en") {
  const dir = mkdtempSync(join(tmpdir(), "aj-idx-"));
  const paths = storePaths(dir);
  const cfg = ConfigSchema.parse({ memoryDir: dir, search: "fts", language });
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

  it("stems with the porter tokenizer (query 'debug' matches 'debugging')", async () => {
    const { paths, indexer } = setup();
    close = () => indexer.close();
    await writePage(paths, "gamma", "spent the night debugging asynchronous handlers", {});
    await indexer.sync();
    expect((await indexer.search("debug", 5)).map((h) => h.id)).toContain("gamma");
    expect((await indexer.search("handler", 5)).map((h) => h.id)).toContain("gamma");
  });

  it("folds diacritics so an unaccented query matches accented text", async () => {
    const { paths, indexer } = setup("pl");
    close = () => indexer.close();
    await writePage(paths, "delta", "Konferencja w Krakowie, książka Müllera, café na rogu.", {});
    await indexer.sync();
    for (const q of ["krakowie", "ksiazka", "mullera", "cafe"]) {
      expect((await indexer.search(q, 5)).map((h) => h.id)).toContain("delta");
    }
  });

  it("uses a trigram tokenizer for CJK so substrings match", async () => {
    const { paths, indexer } = setup("zh");
    close = () => indexer.close();
    await writePage(paths, "epsilon", "机器学习模型的部署与扩展", {});
    await indexer.sync();
    expect((await indexer.search("机器学", 5)).map((h) => h.id)).toContain("epsilon");
  });
});

describe("index signature change", () => {
  it("clears the maintenance watermark so the dropped index is actually rebuilt", async () => {
    // The old failure: a tokenizer/schema change drops pages_fts, page_meta and
    // embeddings, but `meta` survives — and it holds the watermark the server
    // checks to decide whether to run maintenance. Result: an empty index that
    // reports "store unchanged", and search returning nothing for the whole
    // store until some unrelated write happened to move the watermark.
    const dir = mkdtempSync(join(tmpdir(), "aj-sig-"));
    const paths = storePaths(dir);

    const en = ConfigSchema.parse({ memoryDir: dir, search: "fts", language: "en" });
    const first = Indexer.open(paths, en);
    await writePage(paths, "alpha", "a page about billing", {});
    await first.sync();
    setMeta(first.db, "maint_mtime", "9999999999999");
    expect(allIndexedIds(first.db).length).toBe(1);
    first.close();

    // Switching to a language with a different tokenizer changes the signature.
    const ja = ConfigSchema.parse({ memoryDir: dir, search: "fts", language: "ja" });
    const second = Indexer.open(paths, ja);
    expect(allIndexedIds(second.db).length).toBe(0); // tables dropped, as designed
    expect(getMeta(second.db, "maint_mtime")).toBeUndefined(); // ...and so is the watermark
    second.close();
  });
})

describe("recall: a question asked in a sentence", () => {
  it("finds the page even though the question's filler words are not on it", async () => {
    // The product's headline example is "What did we decide about auth?".
    // Every term was ANDed, so every such question returned nothing at all.
    const { paths, indexer } = setup();
    try {
      await writePage(paths, "auth", "We moved authentication to short-lived tokens.", {});
      await writePage(paths, "billing", "Billing runs on Stripe.", {});
      await indexer.sync();

      const hits = await indexer.search("what did we decide about authentication?", 5);
      expect(hits.map((h) => h.id)).toContain("auth");
    } finally {
      indexer.close();
    }
  });

  it("ranks a title match above a passing mention in a body", async () => {
    const { paths, indexer } = setup();
    try {
      await writePage(paths, "pricing", "---\ntitle: Pricing\n---\n\nThe plan table lives here.", {});
      await writePage(paths, "notes", "A long note that mentions pricing once, in passing, among other things.", {});
      await indexer.sync();
      expect((await indexer.search("pricing", 5))[0]!.id).toBe("pricing");
    } finally {
      indexer.close();
    }
  });

  it("says when a hit came from a loosened query", async () => {
    const { paths, indexer } = setup();
    try {
      await writePage(paths, "deploys", "Deploys go out through Elastic Beanstalk.", {});
      await indexer.sync();
      const strict = await indexer.search("deploys beanstalk", 5);
      expect(strict[0]!.via).toBe("fts");
      const loose = await indexer.search("deploys and something entirely unrelated", 5);
      expect(loose.length).toBeGreaterThan(0);
      expect(loose[0]!.via).toBe("fts-loose");
    } finally {
      indexer.close();
    }
  });

  it("does not hand back the whole store for one common word", async () => {
    const { paths, indexer } = setup();
    try {
      for (const id of ["one", "two", "three", "four"]) {
        await writePage(paths, id, "the system runs nightly", {});
      }
      await writePage(paths, "target", "the system runs nightly and rotates credentials", {});
      await indexer.sync();
      // "credentials" is the distinctive word; the filler must not drag in the rest.
      const hits = await indexer.search("the system credentials", 10);
      expect(hits[0]!.id).toBe("target");
    } finally {
      indexer.close();
    }
  });

  it("survives a query full of FTS syntax", async () => {
    const { paths, indexer } = setup();
    try {
      await writePage(paths, "page", "ordinary content", {});
      await indexer.sync();
      for (const q of ['"unbalanced', "NEAR(", "a* OR", "^:-)", "()"]) {
        await expect(indexer.search(q, 5)).resolves.toBeInstanceOf(Array);
      }
    } finally {
      indexer.close();
    }
  });
});

describe("letters and scripts the tokenizer alone cannot handle", () => {
  it("finds Łódź when you type Lodz", async () => {
    // remove_diacritics folds everything that decomposes — ą, ć, ę, ó, ś, ź, ż —
    // but ł does not decompose, so it never folded. The comment in db.ts used to
    // offer this exact example as proof it worked.
    const { paths, indexer } = setup("pl");
    try {
      await writePage(paths, "miasto", "Konferencja w Łodzi, potem Gdańsk. Było miło.", {});
      await indexer.sync();
      expect((await indexer.search("lodzi", 5)).map((h) => h.id)).toContain("miasto");
      expect((await indexer.search("bylo", 5)).map((h) => h.id)).toContain("miasto");
      // and the real spelling still works
      expect((await indexer.search("Łodzi", 5)).map((h) => h.id)).toContain("miasto");
    } finally {
      indexer.close();
    }
  });

  it("keeps the real spelling in the snippet", async () => {
    const { paths, indexer } = setup("pl");
    try {
      await writePage(paths, "miasto", "Konferencja w Łodzi, potem Gdańsk.", {});
      await indexer.sync();
      const hit = (await indexer.search("Gdańsk", 5))[0]!;
      expect(hit.snippet).toContain("Łodzi");
    } finally {
      indexer.close();
    }
  });

  it("answers a two-character query in a language written without spaces", async () => {
    // The trigram tokenizer the index picks for CJK cannot match fewer than
    // three characters, which is the ordinary length of a word in those
    // languages — the tokenizer chosen for them failed their commonest query.
    const { paths, indexer } = setup("ja");
    try {
      await writePage(paths, "ml", "機械学習モデルの展開と拡張", {});
      await indexer.sync();
      expect((await indexer.search("機械", 5)).map((h) => h.id)).toContain("ml");
    } finally {
      indexer.close();
    }
  });
});

describe("dates are the user's, not UTC's", () => {
  it("stamps the local calendar day", async () => {
    // 23:30 on the 19th in UTC+2 is still the 19th, not the 20th.
    const local = new Date("2026-09-19T21:30:00Z");
    const stamped = todayISO(local);
    const expected = new Date(local.getTime() - local.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    expect(stamped).toBe(expected);
  });
});
