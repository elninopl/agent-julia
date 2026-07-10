import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Indexer } from "../src/index/indexer.js";
import { EmbeddingProvider } from "../src/index/embeddings.js";
import { embeddedIds } from "../src/index/semantic.js";
import { storePaths } from "../src/store/paths.js";
import { writePage } from "../src/store/markdown.js";
import { ConfigSchema } from "../src/config/schema.js";

// Deterministic fake: the vector counts occurrences of three keywords, so texts
// about the same topic land close in cosine space — no model needed.
const TOPICS = ["coffee", "sailing", "sqlite"];
function vec(text: string): number[] {
  const t = text.toLowerCase();
  const v = TOPICS.map((k) => t.split(k).length - 1 + 0.01);
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

function fakeProvider(failFor: Set<string> = new Set()): EmbeddingProvider {
  return {
    id: "fake-v1",
    dims: 3,
    enabled: true,
    async embed(texts) {
      return texts.map((t) => {
        for (const f of failFor) if (t.includes(f)) throw new Error(`fail on ${f}`);
        return vec(t);
      });
    },
    async embedQuery(text) {
      return vec(text);
    },
  };
}

function freshStore(search: "semantic" | "hybrid") {
  const dir = mkdtempSync(join(tmpdir(), "aj-sem-"));
  const config = ConfigSchema.parse({ memoryDir: dir, git: false, search, embedding: { provider: "local" } });
  return { paths: storePaths(dir), config };
}

describe("semantic search", () => {
  it("ranks by meaning, not keywords", async () => {
    const { paths, config } = freshStore("semantic");
    await writePage(paths, "brew-notes", "coffee coffee coffee brewing at home", {});
    await writePage(paths, "boat-log", "sailing sailing across the bay", {});
    await writePage(paths, "db-page", "sqlite pragmas and sqlite indexes", {});
    const idx = Indexer.open(paths, config, fakeProvider());
    await idx.sync();

    const hits = await idx.search("morning coffee ritual", 3);
    expect(hits[0]!.id).toBe("brew-notes");
    idx.close();
  });
});

describe("hybrid search", () => {
  it("fuses keyword and semantic hits", async () => {
    const { paths, config } = freshStore("hybrid");
    await writePage(paths, "brew-notes", "coffee coffee espresso and grinders", {});
    await writePage(paths, "boat-log", "sailing the regatta", {});
    const idx = Indexer.open(paths, config, fakeProvider());
    await idx.sync();

    const hits = await idx.search("coffee", 2);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.id).toBe("brew-notes");
    idx.close();
  });
});

describe("reembedIfStale fills gaps without wiping healthy vectors", () => {
  it("embeds only the pages whose embed failed, on the next run", async () => {
    const { paths, config } = freshStore("semantic");
    await writePage(paths, "good-one", "coffee notes", {});
    await writePage(paths, "flaky-one", "sailing POISON log", {});

    // First pass: one page's embed fails — it gets indexed without a vector.
    let idx = Indexer.open(paths, config, fakeProvider(new Set(["POISON"])));
    await idx.sync();
    expect(embeddedIds(idx.db).sort()).toEqual(["good-one"]);
    idx.close();

    // Recovery pass: only the gap is embedded; the healthy vector is untouched.
    idx = Indexer.open(paths, config, fakeProvider());
    const did = await idx.reembedIfStale();
    expect(did).toBe(true);
    expect(embeddedIds(idx.db).sort()).toEqual(["flaky-one", "good-one"]);

    // Nothing missing anymore: a further run is a no-op.
    expect(await idx.reembedIfStale()).toBe(false);
    idx.close();
  });
});
