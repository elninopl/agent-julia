import { EmbeddingConfig } from "../config/schema.js";
import { warn } from "../util/log.js";

// A pluggable embedding backend. The "none" provider keeps agent-julia fully
// offline and key-free; hybrid/semantic search then transparently degrade to FTS.
export interface EmbeddingProvider {
  readonly id: string; // stable identifier stored alongside vectors (model fingerprint)
  readonly dims: number;
  readonly enabled: boolean;
  embed(texts: string[]): Promise<number[][]>;
}

class NoneProvider implements EmbeddingProvider {
  readonly id = "none";
  readonly dims = 0;
  readonly enabled = false;
  async embed(): Promise<number[][]> {
    return [];
  }
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
}

export function makeEmbeddingProvider(cfg: EmbeddingConfig): EmbeddingProvider {
  if (cfg.provider === "openai-compatible") {
    try {
      return new OpenAICompatibleProvider(cfg);
    } catch (err) {
      warn("failed to init embedding provider, falling back to none:", (err as Error).message);
      return new NoneProvider();
    }
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
