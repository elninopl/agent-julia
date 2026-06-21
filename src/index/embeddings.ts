import { EmbeddingConfig } from "../config/schema.js";
import { warn } from "../util/log.js";

// A pluggable embedding backend. The "none" provider keeps agent-julia fully
// offline and key-free; hybrid/semantic search then transparently degrade to FTS.
// The "local" provider runs a small model in-process (no server, no API).
export interface EmbeddingProvider {
  readonly id: string; // stable identifier stored alongside vectors (model fingerprint)
  readonly dims: number;
  readonly enabled: boolean;
  // Embed documents/passages (used when indexing).
  embed(texts: string[]): Promise<number[][]>;
  // Embed a single query. Some models (e5) need an asymmetric prefix vs documents;
  // by default it's the same as embed().
  embedQuery(text: string): Promise<number[] | null>;
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

// Local, in-process embeddings via transformers.js (ONNX). No server, no API key,
// fully offline after the first model download. Optional dependency: loaded
// dynamically so the base install stays tiny. Model: multilingual-e5-small (384d,
// ~118 languages) — a good fit for a multilingual memory.
const LOCAL_MODEL = "Xenova/multilingual-e5-small";
const LOCAL_PKG = "@huggingface/transformers";

class LocalProvider implements EmbeddingProvider {
  readonly enabled = true;
  readonly dims = 384;
  readonly id = `local:${LOCAL_MODEL}:384`;
  // Cache the (heavy) pipeline load.
  private pipe: Promise<(input: string[], opts: object) => Promise<{ tolist(): number[][] }>> | null = null;

  private async extractor() {
    if (!this.pipe) {
      this.pipe = (async () => {
        const mod = (await import(LOCAL_PKG)) as { pipeline: (task: string, model: string) => Promise<unknown> };
        return (await mod.pipeline("feature-extraction", LOCAL_MODEL)) as (
          input: string[],
          opts: object,
        ) => Promise<{ tolist(): number[][] }>;
      })();
    }
    return this.pipe;
  }

  // e5 expects "passage: " for documents and "query: " for queries.
  private async run(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extract = await this.extractor();
    const out = await extract(texts, { pooling: "mean", normalize: true });
    return out.tolist();
  }

  async embed(texts: string[]): Promise<number[][]> {
    return this.run(texts.map((t) => `passage: ${t}`));
  }

  async embedQuery(text: string): Promise<number[] | null> {
    const [v] = await this.run([`query: ${text}`]);
    return v ?? null;
  }
}

// Default embedQuery for providers where query and document share the same space.
async function symmetricQuery(provider: EmbeddingProvider, text: string): Promise<number[] | null> {
  const [v] = await provider.embed([text]);
  return v ?? null;
}

// Probe whether the optional local-embeddings package is installed, so the wizard
// can guide the user before they commit to it.
export async function checkLocalEmbeddingsAvailable(): Promise<boolean> {
  try {
    await import(LOCAL_PKG);
    return true;
  } catch {
    return false;
  }
}

export const LOCAL_EMBEDDINGS_PACKAGE = LOCAL_PKG;

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
    if (cfg.provider === "local") return new LocalProvider();
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
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
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
