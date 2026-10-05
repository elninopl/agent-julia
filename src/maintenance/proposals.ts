import { Indexer } from "../index/indexer.js";
import { blobToVector, cosineSimilarity } from "../index/embeddings.js";
import { StorePaths } from "../store/paths.js";
import { extractLinks, listPageIds, readPage } from "../store/markdown.js";
import { estimateTokens } from "../util/tokens.js";

// Owner-judgment candidates for the weekly digest. Everything here is a
// PROPOSAL: deterministic code gathers the candidates, the agent walks the
// owner through them one at a time, and nothing changes without a yes. The
// judgment calls (is this really a duplicate? still true?) belong to the
// human + model, not to this code.
export interface Proposals {
  // Pages whose embeddings are suspiciously close — merge candidates.
  nearDuplicates: Array<{ a: string; b: string; similarity: number }>;
  // Dated pages long untouched — confirm, refresh, or archive.
  staleCandidates: Array<{ id: string; updated: string }>;
  // [[links]] pointing at pages that don't exist — create or unlink.
  orphanLinks: Array<{ from: string; to: string }>;
  // Pages nothing links to and that link to nothing — connect or archive.
  unlinkedPages: string[];
  // Pages so large they blur "one entity per page" — split candidates.
  oversizedPages: Array<{ id: string; tokens: number }>;
}

// A floor, not the signal: e5 puts unrelated text of the same store well above
// 0.9 (median page pair 0.87 on a 221-page store), so the closest few pairs are
// what is worth an owner's time, not every pair over a line.
const DUPLICATE_SIMILARITY = 0.9;
const MAX_DUPLICATES = 10;
const OVERSIZED_TOKENS = 1200;
const STALE_AFTER_DAYS = 270;

export async function buildProposals(paths: StorePaths, indexer: Indexer): Promise<Proposals> {
  const ids = await listPageIds(paths);
  const idSet = new Set(ids);

  // Link graph + stale + oversized in one pass over the pages.
  const orphanLinks: Proposals["orphanLinks"] = [];
  const staleCandidates: Proposals["staleCandidates"] = [];
  const oversizedPages: Proposals["oversizedPages"] = [];
  const outbound = new Map<string, string[]>();
  const hasInbound = new Set<string>();
  const cutoff = Date.now() - STALE_AFTER_DAYS * 24 * 3600 * 1000;

  for (const id of ids) {
    const page = await readPage(paths, id);
    if (!page) continue;
    const links = extractLinks(page.body).filter((l) => l !== id);
    outbound.set(id, links);
    for (const link of links) {
      if (idSet.has(link)) hasInbound.add(link);
      else orphanLinks.push({ from: id, to: link });
    }
    const updated = page.frontmatter.updated;
    if (updated && Date.parse(updated) < cutoff) staleCandidates.push({ id, updated });
    const tokens = estimateTokens(page.body);
    if (tokens > OVERSIZED_TOKENS) oversizedPages.push({ id, tokens });
  }

  const unlinkedPages = ids.filter(
    (id) => !hasInbound.has(id) && (outbound.get(id) ?? []).filter((l) => idSet.has(l)).length === 0,
  );

  // Near-duplicates: how close each pair of pages gets at its closest parts.
  // Vectors are stored per chunk, and comparing rows as if they were pages
  // paired every page with itself and listed each page pair once per matching
  // chunk pair: on a 221-page store that was 4,664 proposals, 1,061 of them a
  // page and itself. Only the active model's vectors are compared. O(chunks²)
  // over a personal KB is nothing; skipped entirely when embeddings are off.
  const nearDuplicates: Proposals["nearDuplicates"] = [];
  if (indexer.provider.enabled) {
    const rows = indexer.db
      .prepare("SELECT id, vector FROM embeddings WHERE model = ?")
      .all(indexer.provider.id) as Array<{ id: string; vector: Buffer }>;
    const vecs = rows
      .filter((r) => idSet.has(r.id))
      .map((r) => ({ id: r.id, vec: blobToVector(r.vector) }));
    const closest = new Map<string, { a: string; b: string; similarity: number }>();
    for (let i = 0; i < vecs.length; i++) {
      for (let j = i + 1; j < vecs.length; j++) {
        const x = vecs[i]!;
        const y = vecs[j]!;
        if (x.id === y.id || x.vec.length !== y.vec.length) continue;
        const sim = cosineSimilarity(x.vec, y.vec);
        if (sim < DUPLICATE_SIMILARITY) continue;
        const [a, b] = x.id < y.id ? [x.id, y.id] : [y.id, x.id];
        const key = `${a}\u0000${b}`;
        const prev = closest.get(key);
        if (!prev || sim > prev.similarity) closest.set(key, { a, b, similarity: sim });
      }
    }
    nearDuplicates.push(
      ...[...closest.values()]
        .sort((x, y) => y.similarity - x.similarity)
        .slice(0, MAX_DUPLICATES)
        .map((d) => ({ ...d, similarity: Number(d.similarity.toFixed(3)) })),
    );
  }

  return { nearDuplicates, staleCandidates, orphanLinks, unlinkedPages, oversizedPages };
}
