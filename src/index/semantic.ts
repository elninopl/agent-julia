import { createHash } from "node:crypto";
import { warn } from "../util/log.js";
import { DB } from "./db.js";
import {
  EmbeddingProvider,
  blobToVector,
  cosineSimilarity,
  vectorToBlob,
} from "./embeddings.js";

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

export interface EmbeddedChunk {
  chunk: Chunk;
  vector: number[];
  hash: string;
}

const chunkHash = (input: string): string => createHash("sha1").update(input).digest("hex");

// Vectors this page already has under `model`, by the hash of the text each
// was made from.
export function knownVectors(db: DB, id: string, model: string): Map<string, number[]> {
  const rows = db
    .prepare("SELECT hash, vector FROM embeddings WHERE id = ? AND model = ? AND hash IS NOT NULL")
    .all(id, model) as Array<{ hash: string; vector: Buffer }>;
  return new Map(rows.map((r) => [r.hash, Array.from(blobToVector(r.vector))]));
}

// Embedding is async (model or network), so callers run it BEFORE opening a
// write transaction — never hold a DB lock across an embed.
//
// Only the chunks whose text is new are sent to the provider. An append used
// to re-embed the whole page: one line added to a 60-chunk page cost 60
// chunks of inference, ~2.4 s, under the store lock every other writer waits on.
export async function embedChunks(
  provider: EmbeddingProvider,
  title: string,
  body: string,
  known: Map<string, number[]> = new Map(),
): Promise<EmbeddedChunk[] | null> {
  if (!provider.enabled) return null;
  const chunks = chunkPage(title, body).map((chunk) => {
    const input = `${title} — ${chunk.label}\n${chunk.text}`;
    return { chunk, input, hash: chunkHash(input) };
  });
  const missing = chunks.filter((c) => !known.has(c.hash));
  try {
    // One batch per page: the provider batches further if it needs to.
    const fresh = missing.length > 0 ? await provider.embed(missing.map((c) => c.input)) : [];
    const made = new Map(missing.map((c, i) => [c.hash, fresh[i]]));
    return chunks
      .map((c) => ({ chunk: c.chunk, hash: c.hash, vector: known.get(c.hash) ?? made.get(c.hash)! }))
      .filter((r) => r.vector);
  } catch (err) {
    onEmbedError(err);
    return null;
  }
}

// Store a precomputed vector. Synchronous, so it composes into a transaction
// with the FTS upsert and page-hash write.
export function semanticStore(db: DB, provider: EmbeddingProvider, id: string, rows: EmbeddedChunk[]): void {
  db.prepare("DELETE FROM embeddings WHERE id = ?").run(id);
  const insert = db.prepare(
    "INSERT INTO embeddings (id, chunk, label, model, dims, vector, hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  rows.forEach((r, i) => {
    insert.run(id, i, r.chunk.label, provider.id, provider.dims, vectorToBlob(r.vector), r.hash);
  });
}

export function embeddingCount(db: DB): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number } | undefined;
  return row?.n ?? 0;
}

// Pages with vectors from `model`; with no model given, from any model.
export function embeddedIds(db: DB, model?: string): string[] {
  const rows = (
    model === undefined
      ? db.prepare("SELECT DISTINCT id FROM embeddings").all()
      : db.prepare("SELECT DISTINCT id FROM embeddings WHERE model = ?").all(model)
  ) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

// Indexed pages that have no vectors from `model`: all of them after a change
// of model or precision, otherwise the odd page whose embed failed.
export function pagesWithoutVectors(db: DB, model: string): string[] {
  const rows = db
    .prepare("SELECT id FROM page_meta WHERE id NOT IN (SELECT id FROM embeddings WHERE model = ?)")
    .all(model) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

// Drop what an earlier model left behind, once its replacement is complete.
export function dropOtherModels(db: DB, model: string): void {
  db.prepare("DELETE FROM embeddings WHERE model != ?").run(model);
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
  // Only vectors from the model that embedded the query. Another model's, even
  // with the same dimensions, live in a different space: while a model change
  // is being re-embedded, pages not yet done are missing from semantic results
  // (keyword search still finds them) rather than ranked by noise.
  const rows = db.prepare("SELECT id, label, vector FROM embeddings WHERE model = ?").all(provider.id) as Array<{
    id: string;
    label: string;
    vector: Buffer;
  }>;
  // Best chunk wins for its page: a page is as relevant as its most relevant part.
  const best = new Map<string, SemanticHit>();
  for (const r of rows) {
    const vec = blobToVector(r.vector);
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

export function clearEmbeddings(db: DB): void {
  db.prepare("DELETE FROM embeddings").run();
}
