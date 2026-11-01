import { MountedStore, qualify } from "../store/stores.js";
import { EmbeddingProvider } from "./embeddings.js";
import { SearchResult, SearchSignals, fuseSignals, searchPool } from "./search.js";
import { RELATIVE_FLOOR } from "./semantic.js";

// The query is the same for every store: embed it once.
function embedQueryOnce(provider: EmbeddingProvider): EmbeddingProvider {
  const memo = new Map<string, Promise<number[] | null>>();
  return {
    id: provider.id,
    dims: provider.dims,
    enabled: provider.enabled,
    embed: (texts) => provider.embed(texts),
    embedQuery: (text) => {
      let hit = memo.get(text);
      if (!hit) memo.set(text, (hit = provider.embedQuery(text)));
      return hit;
    },
  };
}

// Search every mounted store as if they were one. Each store contributes its
// keyword and semantic candidates with ids qualified by store; the keyword
// lists are merged by score, the semantic lists by cosine similarity (one model
// for all, so the numbers compare), and the merged lists are fused exactly as a
// single store's are. With one store this is that store's search.
export async function searchStores(stores: MountedStore[], query: string, limit: number): Promise<SearchResult[]> {
  const primary = stores[0]!;
  const mode = primary.config.search;
  const provider = embedQueryOnce(primary.indexer.provider);
  const pool = searchPool(limit);

  const storeOf = new Map<string, string>();
  const per = await Promise.all(
    stores.map(async (s, order) => {
      const sig = await s.indexer.signals(query, pool, provider);
      const q = (id: string) => {
        const qid = qualify(s.name, id);
        if (s.name) storeOf.set(qid, s.name);
        return qid;
      };
      return {
        order,
        rung: sig.fts.length > 0 ? (sig.ftsRung ?? 0) : Infinity,
        fts: sig.fts.map((h) => ({ ...h, id: q(h.id) })),
        sem: sig.sem.map((h) => ({ ...h, id: q(h.id) })),
      };
    }),
  );

  // One store holding all these pages would stop at the best rung of its
  // keyword ladder; a store that only reached a looser one contributes nothing
  // to the keyword list. Without this, a store with no real match pads the list
  // with near misses that a single store would never have returned.
  const bestRung = Math.min(...per.map((p) => p.rung));

  // Stable sorts over the store order, so a tie goes to the primary.
  const byScore = <T extends { score: number }>(lists: T[][]): T[] =>
    lists
      .flatMap((l, order) => l.map((h, rank) => ({ h, order, rank })))
      .sort((a, b) => b.h.score - a.h.score || a.order - b.order || a.rank - b.rank)
      .map((x) => x.h);

  const fts = byScore(per.map((p) => (p.rung === bestRung ? p.fts : []))).slice(0, pool);
  let sem = byScore(per.map((p) => p.sem));
  // Each store cut its semantic list relative to its own best hit; cut the
  // merged list relative to the best of all, so a store with nothing close to
  // the query does not contribute its least bad pages.
  if (sem.length > 0) {
    const floor = sem[0]!.score - RELATIVE_FLOOR;
    sem = sem.filter((h) => h.score >= floor);
  }
  const merged: SearchSignals = { fts, sem: sem.slice(0, pool) };

  return fuseSignals(mode, provider.enabled, merged, limit).map((hit) => {
    const store = storeOf.get(hit.id);
    return store ? { ...hit, store } : hit;
  });
}
