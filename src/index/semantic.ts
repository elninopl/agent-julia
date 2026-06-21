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
}

export function semanticDelete(db: DB, id: string): void {
  db.prepare("DELETE FROM embeddings WHERE id = ?").run(id);
}

export async function semanticUpsert(
  db: DB,
  provider: EmbeddingProvider,
  id: string,
  text: string,
): Promise<void> {
  if (!provider.enabled) return;
  const vec = await provider.embed([text]).then((v) => v[0], onEmbedError);
  if (!vec) return;
  db.prepare(
    `INSERT INTO embeddings (id, model, dims, vector) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET model = excluded.model, dims = excluded.dims, vector = excluded.vector`,
  ).run(id, provider.id, provider.dims, vectorToBlob(vec));
  setMeta(db, MODEL_META_KEY, provider.id);
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
  const rows = db.prepare("SELECT id, vector FROM embeddings").all() as Array<{
    id: string;
    vector: Buffer;
  }>;
  const scored = rows.map((r) => ({ id: r.id, score: cosineSimilarity(q, blobToVector(r.vector)) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
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
