import { SearchMode } from "../config/schema.js";
import { DB } from "./db.js";
import { EmbeddingProvider } from "./embeddings.js";
import { ftsSearch } from "./fts.js";
import { semanticSearch } from "./semantic.js";

export interface SearchResult {
  id: string;
  title: string;
  score: number;
  snippet?: string;
  via: "fts" | "semantic" | "hybrid";
}

// Reciprocal-rank-style fusion of FTS and semantic results. When semantic is
// disabled (provider "none"), hybrid is FTS-only.
export async function search(
  db: DB,
  provider: EmbeddingProvider,
  mode: SearchMode,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const pool = Math.max(limit * 3, 15);

  const wantFts = mode === "fts" || mode === "hybrid";
  const wantSemantic = (mode === "semantic" || mode === "hybrid") && provider.enabled;

  const fts = wantFts ? ftsSearch(db, query, pool) : [];
  const sem = wantSemantic ? await semanticSearch(db, provider, query, pool) : [];

  // Pure modes: return directly (semantic with no provider falls through to []).
  if (mode === "fts" || (mode === "semantic" && !provider.enabled)) {
    return fts.slice(0, limit).map((h) => ({ ...h, via: "fts" as const }));
  }
  if (mode === "semantic") {
    const byId = new Map(fts.map((f) => [f.id, f]));
    return sem.slice(0, limit).map((h) => ({
      id: h.id,
      title: byId.get(h.id)?.title ?? h.id,
      score: h.score,
      snippet: byId.get(h.id)?.snippet,
      via: "semantic" as const,
    }));
  }

  // Hybrid: weighted blend of normalized scores from both signals.
  const merged = new Map<string, SearchResult>();
  fts.forEach((h, i) => {
    merged.set(h.id, {
      id: h.id,
      title: h.title,
      snippet: h.snippet,
      score: 0.5 * rankWeight(i, fts.length),
      via: "hybrid",
    });
  });
  sem.forEach((h, i) => {
    const existing = merged.get(h.id);
    const add = 0.5 * rankWeight(i, sem.length);
    if (existing) existing.score += add;
    else merged.set(h.id, { id: h.id, title: h.id, score: add, via: "hybrid" });
  });

  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

function rankWeight(index: number, total: number): number {
  if (total <= 0) return 0;
  return (total - index) / total;
}
