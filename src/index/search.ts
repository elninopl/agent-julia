import { SearchMode } from "../config/schema.js";
import { DB } from "./db.js";
import { EmbeddingProvider } from "./embeddings.js";
import { FtsHit, ftsLadder, ftsTitle } from "./fts.js";
import { SemanticHit, semanticSearch } from "./semantic.js";

export interface SearchResult {
  id: string;
  title: string;
  score: number;
  snippet?: string;
  via: "fts" | "fts-loose" | "semantic" | "hybrid";
  // Set on hits from a mounted store, never on the primary's.
  store?: string;
}

// A semantic hit with its page title already looked up in its own store's
// index, so hits from several stores can be fused without their databases.
export type TitledSemanticHit = SemanticHit & { title: string };

// The two ranked lists a search is made of, before fusion.
export interface SearchSignals {
  fts: FtsHit[];
  sem: TitledSemanticHit[];
  // Which rung of the keyword ladder answered (see ftsLadder).
  ftsRung?: number;
}

// How many candidates each signal contributes before fusion.
export function searchPool(limit: number): number {
  return Math.max(limit * 3, 15);
}

export async function searchSignals(
  db: DB,
  provider: EmbeddingProvider,
  mode: SearchMode,
  query: string,
  pool: number,
): Promise<SearchSignals> {
  const wantFts = mode === "fts" || mode === "hybrid";
  const wantSemantic = (mode === "semantic" || mode === "hybrid") && provider.enabled;

  const ladder = wantFts ? ftsLadder(db, query, pool) : { hits: [], rung: 0 };
  const fts = ladder.hits;
  const sem = wantSemantic ? await semanticSearch(db, provider, query, pool) : [];
  const titles = new Map(fts.map((f) => [f.id, f.title]));
  return {
    fts,
    sem: sem.map((h) => ({ ...h, title: titles.get(h.id) ?? ftsTitle(db, h.id) ?? h.id })),
    ftsRung: ladder.rung,
  };
}

// Reciprocal-rank-style fusion of FTS and semantic results. When semantic is
// disabled (provider "none"), hybrid is FTS-only.
export function fuseSignals(
  mode: SearchMode,
  semanticEnabled: boolean,
  { fts, sem }: SearchSignals,
  limit: number,
): SearchResult[] {
  // Pure modes: return directly (semantic with no provider falls through to []).
  if (mode === "fts" || (mode === "semantic" && !semanticEnabled)) {
    return fts.slice(0, limit).map((h) => ({ ...h, via: h.via }));
  }
  if (mode === "semantic") {
    const byId = new Map(fts.map((f) => [f.id, f]));
    return sem.slice(0, limit).map((h) => ({
      id: h.id,
      title: byId.get(h.id)?.title ?? h.title,
      score: h.score,
      // A semantic hit used to come back with no snippet at all, so the caller
      // got an id and a number. The matching chunk's heading at least says which
      // part of the page answered.
      snippet: byId.get(h.id)?.snippet ?? h.label,
      via: "semantic" as const,
    }));
  }

  // Hybrid: reciprocal-rank fusion of both signals.
  const merged = new Map<string, SearchResult>();
  fts.forEach((h, i) => {
    merged.set(h.id, {
      id: h.id,
      title: h.title,
      snippet: h.snippet,
      score: 0.5 * rrf(i),
      // A loose keyword hit stays labelled loose even after fusion, so a caller
      // can tell "this is what you asked for" from "this is the closest I have".
      via: h.via === "fts-loose" ? "fts-loose" : "hybrid",
    });
  });
  sem.forEach((h, i) => {
    const existing = merged.get(h.id);
    const add = 0.5 * rrf(i);
    if (existing) existing.score += add;
    else
      merged.set(h.id, {
        id: h.id,
        title: h.title,
        score: add,
        snippet: h.label,
        via: "hybrid",
      });
  });

  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function search(
  db: DB,
  provider: EmbeddingProvider,
  mode: SearchMode,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const signals = await searchSignals(db, provider, mode, query, searchPool(limit));
  return fuseSignals(mode, provider.enabled, signals, limit);
}

// Reciprocal-rank fusion weight: 1/(k+rank), k=60 (the standard RRF constant).
// Rank position drives the score, so two ranked lists fuse without needing their
// raw scores to be comparable.
export function rrf(index: number): number {
  return 1 / (60 + index);
}
