import { warn } from "../util/log.js";
import { DB, getMeta, setMeta } from "./db.js";
import {
  EmbeddingProvider,
  blobToVector,
  cosineSimilarity,
  vectorToBlob,
} from "./embeddings.js";

const MODEL_META_KEY = "embedding_model_id";

// A provider can fail at embed time (the optional local package isn't installed,
// or an API call errors). Rather than break an ingest or a search, fall back to
// keyword-only and warn once.
let embedWarned = false;
function onEmbedError(err: unknown): null {
  if (!embedWarned) {
    warn("embeddings unavailable, using keyword search only:", (err as Error).message);
    embedWarned = true;
  }
  return null;
}

export interface SemanticHit {
  id: string;
  score: number; // cosine similarity in [0, 1]
  // Which part of the page matched, for a snippet the user can read.
  label?: string;
}

// Keep only what is close to the best match. An absolute floor is unusable
// across models — e5 packs everything into a narrow band — but "much worse than
// the best thing I found" travels. Without it, semantic search always returned
// a full page of results, so "no, I don't know that" was not an answer the
// product could give.
const RELATIVE_FLOOR = 0.06;

export function semanticDelete(db: DB, id: string): void {
  db.prepare("DELETE FROM embeddings WHERE id = ?").run(id);
}

// Split a page for embedding. Headings are the author's own idea of where one
// topic ends, so they are the split points; anything still too long is cut on a
// paragraph boundary. Each chunk carries a label (its heading) so a semantic hit
// can say which part of the page matched.
const MAX_CHUNK_CHARS = 1400; // ~450 tokens, inside the 512 these models accept
const MIN_CHUNK_CHARS = 200; // below this, fold into the neighbour

export interface Chunk {
  label: string;
  text: string;
}

export function chunkPage(title: string, body: string): Chunk[] {
  const sections: Chunk[] = [];
  let label = title;
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) sections.push({ label, text });
    buf = [];
  };
  for (const line of body.split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flush();
      label = heading[1]!.trim() || title;
      continue;
    }
    buf.push(line);
  }
  flush();

  // Fold tiny sections forward, then hard-split anything still oversized.
  const merged: Chunk[] = [];
  for (const s of sections) {
    const last = merged[merged.length - 1];
    if (last && last.text.length < MIN_CHUNK_CHARS) {
      last.text = `${last.text}\n\n${s.text}`;
    } else {
      merged.push({ ...s });
    }
  }
  const out: Chunk[] = [];
  for (const s of merged) {
    if (s.text.length <= MAX_CHUNK_CHARS) {
      out.push(s);
      continue;
    }
    let rest = s.text;
    while (rest.length > MAX_CHUNK_CHARS) {
      const window = rest.slice(0, MAX_CHUNK_CHARS);
      const cut = window.lastIndexOf("\n\n");
      const at = cut > MAX_CHUNK_CHARS * 0.4 ? cut : MAX_CHUNK_CHARS;
      out.push({ label: s.label, text: rest.slice(0, at).trim() });
      rest = rest.slice(at).trim();
    }
    if (rest) out.push({ label: s.label, text: rest });
  }
  // A page with a title and no body still gets one chunk.
  return out.length > 0 ? out : [{ label: title, text: title }];
}

// Embedding is async (model or network), so callers run it BEFORE opening a
// write transaction — never hold a DB lock across an embed.
export async function embedChunks(
  provider: EmbeddingProvider,
  title: string,
  body: string,
): Promise<Array<{ chunk: Chunk; vector: number[] }> | null> {
  if (!provider.enabled) return null;
  const chunks = chunkPage(title, body);
  try {
    // One batch per page: the provider interface has always been batch-capable
    // and was only ever called with a single element.
    const vectors = await provider.embed(chunks.map((c) => `${title} — ${c.label}\n${c.text}`));
    return chunks.map((chunk, i) => ({ chunk, vector: vectors[i]! })).filter((r) => r.vector);
  } catch (err) {
    onEmbedError(err);
    return null;
  }
}

// Store a precomputed vector. Synchronous, so it composes into a transaction
// with the FTS upsert and page-hash write.
export function semanticStore(
  db: DB,
  provider: EmbeddingProvider,
  id: string,
  rows: Array<{ chunk: Chunk; vector: number[] }>,
): void {
  db.prepare("DELETE FROM embeddings WHERE id = ?").run(id);
  const insert = db.prepare(
    "INSERT INTO embeddings (id, chunk, label, model, dims, vector) VALUES (?, ?, ?, ?, ?, ?)",
  );
  rows.forEach((r, i) => {
    insert.run(id, i, r.chunk.label, provider.id, provider.dims, vectorToBlob(r.vector));
  });
  setMeta(db, MODEL_META_KEY, provider.id);
}

export function embeddingCount(db: DB): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number } | undefined;
  return row?.n ?? 0;
}

export function embeddedIds(db: DB): string[] {
  const rows = db.prepare("SELECT DISTINCT id FROM embeddings").all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export async function semanticSearch(
  db: DB,
  provider: EmbeddingProvider,
  query: string,
  limit: number,
): Promise<SemanticHit[]> {
  if (!provider.enabled) return [];
  const q = await provider.embedQuery(query).catch(onEmbedError);
  if (!q) return [];
  const rows = db.prepare("SELECT id, label, vector FROM embeddings").all() as Array<{
    id: string;
    label: string;
    vector: Buffer;
  }>;
  // Best chunk wins for its page: a page is as relevant as its most relevant part.
  const best = new Map<string, SemanticHit>();
  for (const r of rows) {
    const vec = blobToVector(r.vector);
    // Skip vectors whose dimensionality doesn't match the query model (e.g. a
    // leftover from a different model) — a prefix cosine would be meaningless.
    if (vec.length !== q.length) continue;
    const score = cosineSimilarity(q, vec);
    const prev = best.get(r.id);
    if (!prev || score > prev.score) best.set(r.id, { id: r.id, score, label: r.label });
  }
  const scored = [...best.values()].sort((a, b) => b.score - a.score);
  if (scored.length === 0) return [];
  const cutoff = scored[0]!.score - RELATIVE_FLOOR;
  return scored.filter((h) => h.score >= cutoff).slice(0, limit);
}

// If the active model fingerprint differs from what produced the stored vectors,
// the embeddings are stale and must be rebuilt. Caller triggers a re-embed.
export function embeddingsAreStale(db: DB, provider: EmbeddingProvider): boolean {
  if (!provider.enabled) return false;
  const stored = getMeta(db, MODEL_META_KEY);
  return stored !== undefined && stored !== provider.id;
}

export function clearEmbeddings(db: DB): void {
  db.prepare("DELETE FROM embeddings").run();
}
