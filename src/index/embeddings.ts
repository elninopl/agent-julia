import { EmbeddingConfig, LocalDtype } from "../config/schema.js";
import { warn } from "../util/log.js";
import { EmbedProcess } from "./embed-process.js";

// A pluggable embedding backend. The "none" provider keeps agent-julia fully
// offline and key-free; hybrid/semantic search then fall back to FTS. The
// "local" provider runs a small model on this machine (no server, no API).
export interface EmbeddingProvider {
  readonly id: string; // stable identifier stored alongside vectors (model fingerprint)
  readonly dims: number;
  readonly enabled: boolean;
  // Embed documents/passages (used when indexing).
  embed(texts: string[]): Promise<number[][]>;
  // Embed a single query. Some models (e5) need an asymmetric prefix vs documents;
  // by default it's the same as embed().
  embedQuery(text: string): Promise<number[] | null>;
  // Release whatever the provider holds (the local model's process).
  close?(): void;
}

class NoneProvider implements EmbeddingProvider {
  readonly id = "none";
  readonly dims = 0;
  readonly enabled = false;
  async embed(): Promise<number[][]> {
    return [];
  }
  async embedQuery(): Promise<number[] | null> {
    return null;
  }
}

// Local embeddings via transformers.js (ONNX). No server, no API key, fully
// offline after the first model download. Optional dependency, and never loaded
// into the server's own process: the model runs in a short-lived child
// (embed-process.ts).
// Models are the multilingual-e5 family (~118 languages); the wizard offers
// small/base/large quality tiers.
const LOCAL_PKG = "@huggingface/transformers";
const DEFAULT_LOCAL_MODEL = "Xenova/multilingual-e5-small";
const DEFAULT_LOCAL_DTYPE: LocalDtype = "q8";

class LocalProvider implements EmbeddingProvider {
  readonly enabled = true;
  readonly dims: number;
  readonly id: string;
  private readonly worker: EmbedProcess;

  constructor(cfg: EmbeddingConfig) {
    const model = cfg.model ?? DEFAULT_LOCAL_MODEL;
    const dtype = cfg.dtype ?? DEFAULT_LOCAL_DTYPE;
    this.dims = cfg.dims ?? 384;
    // The precision is part of the fingerprint: q8 and fp32 vectors of the same
    // text are close but not equal, so changing it re-embeds the store once.
    this.id = `local:${model}:${this.dims}:${dtype}`;
    this.worker = new EmbedProcess({ model, dtype });
  }

  // e5 expects "passage: " for documents and "query: " for queries.
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return this.worker.embed(texts.map((t) => `passage: ${t}`));
  }

  async embedQuery(text: string): Promise<number[] | null> {
    const [v] = await this.worker.embed([`query: ${text}`]);
    return v ?? null;
  }

  close(): void {
    this.worker.close();
  }
}

// Default embedQuery for providers where query and document share the same space.
async function symmetricQuery(provider: EmbeddingProvider, text: string): Promise<number[] | null> {
  const [v] = await provider.embed([text]);
  return v ?? null;
}

// Probe whether the optional local-embeddings package is installed, so the wizard
// can guide the user before they commit to it. Imports it into the calling
// process, so it is for short-lived commands (wizard, doctor), never the server.
export async function checkLocalEmbeddingsAvailable(): Promise<boolean> {
  try {
    await import(LOCAL_PKG);
    return true;
  } catch {
    return false;
  }
}

export const LOCAL_EMBEDDINGS_PACKAGE = LOCAL_PKG;

// Local model quality tiers (multilingual-e5 family), measured at q8 on an
// Apple Silicon Mac. `disk` is the one-time download, cached by transformers.js.
// `ram` is what the embedding process holds while it is alive — from the first
// search or write until a minute after the last one — and nothing otherwise.
// Per chunk of ~450 tokens: small ~19 ms, base ~37 ms, large ~110 ms.
export const LOCAL_MODEL_TIERS = {
  small: { model: "Xenova/multilingual-e5-small", dims: 384, disk: "~120 MB", ram: "~0.8 GB" },
  base: { model: "Xenova/multilingual-e5-base", dims: 768, disk: "~280 MB", ram: "~1.1 GB" },
  large: { model: "Xenova/multilingual-e5-large", dims: 1024, disk: "~560 MB", ram: "~1.7 GB" },
} as const;
export type LocalModelTier = keyof typeof LOCAL_MODEL_TIERS;

// Suggest a tier from the machine's RAM and CPU cores. RAM rarely binds — even
// large holds ~1.7 GB, and only while it is in use — so the real cost of a
// bigger model is slower CPU inference per query, and cores matter more. Stay
// conservative: large stays a deliberate opt-in rather than a recommendation.
export function recommendLocalTier(totalRamGB: number, cpuCores: number): LocalModelTier {
  if (totalRamGB < 8 || cpuCores < 4) return "small";
  if (totalRamGB >= 16 && cpuCores >= 8) return "base";
  return "small";
}

// Minimal OpenAI-compatible embeddings client (works with OpenAI, Ollama's
// /v1/embeddings, LM Studio, etc.). API key is read from env, never persisted.
class OpenAICompatibleProvider implements EmbeddingProvider {
  readonly enabled = true;
  readonly id: string;
  readonly dims: number;
  private readonly url: string;
  private readonly model: string;
  private readonly apiKey: string;

  constructor(cfg: EmbeddingConfig) {
    this.model = cfg.model ?? "text-embedding-3-small";
    this.dims = cfg.dims ?? 1536;
    this.id = `openai-compatible:${this.model}:${this.dims}`;
    const base = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.url = `${base}/embeddings`;
    this.apiKey = process.env[cfg.apiKeyEnv] ?? "";
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`embeddings request failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return json.data.map((d) => d.embedding);
  }

  embedQuery(text: string): Promise<number[] | null> {
    return symmetricQuery(this, text);
  }
}

export function makeEmbeddingProvider(cfg: EmbeddingConfig): EmbeddingProvider {
  try {
    if (cfg.provider === "openai-compatible") return new OpenAICompatibleProvider(cfg);
    if (cfg.provider === "local") return new LocalProvider(cfg);
  } catch (err) {
    warn("failed to init embedding provider, falling back to none:", (err as Error).message);
  }
  return new NoneProvider();
}

// Serialize/deserialize float vectors as compact Float32 blobs for sqlite storage.
export function vectorToBlob(vec: number[]): Buffer {
  const f32 = Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function blobToVector(buf: Buffer): Float32Array {
  // SQLite BLOB Buffers are views into a shared, often 4-byte-unaligned pool, and
  // Float32Array requires an aligned offset — wrapping the raw buffer throws
  // RangeError. Copy into a fresh, aligned ArrayBuffer.
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
