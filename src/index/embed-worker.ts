// Child process holding the local embedding model; see embed-process.ts for why
// it is a separate process. Started with the model and dtype as arguments,
// answers one request at a time over IPC, and exits when the parent goes.

const LOCAL_PKG = "@huggingface/transformers";
// Peak native memory follows the batch size, speed does not: multilingual-e5-base
// at q8 sits at ~0.9 GB after 40 chunks embedded 8 at a time and ~1.6 GB after
// the same 40 in one batch, both at ~40 ms per chunk.
const BATCH = 8;

type Extractor = (input: string[], opts: object) => Promise<{ tolist(): number[][] }>;

const [model, dtype] = process.argv.slice(2);
let extractor: Promise<Extractor> | null = null;

function load(): Promise<Extractor> {
  extractor ??= (async () => {
    const mod = (await import(LOCAL_PKG)) as {
      pipeline: (task: string, model: string, opts: object) => Promise<unknown>;
    };
    return (await mod.pipeline("feature-extraction", model!, { dtype })) as Extractor;
  })();
  return extractor;
}

async function run(extract: Extractor, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const res = await extract(texts.slice(i, i + BATCH), { pooling: "mean", normalize: true });
    out.push(...res.tolist());
  }
  return out;
}

const reply = (msg: object): void => {
  process.send?.(msg);
};
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

process.on("message", (msg: { id: number; texts: string[] }) => {
  void (async () => {
    let extract: Extractor;
    try {
      extract = await load();
    } catch (err) {
      reply({ id: msg.id, error: message(err), fatal: true });
      return;
    }
    try {
      reply({ id: msg.id, vectors: await run(extract, msg.texts) });
    } catch (err) {
      reply({ id: msg.id, error: message(err) });
    }
  })();
});

// The parent closed the channel or died: nothing is left to answer.
process.on("disconnect", () => process.exit(0));

export {};
