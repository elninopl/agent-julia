// Stands in for @huggingface/transformers in tests, via fake-transformers-hook.mjs.
// Every import, pipeline load and batch is appended to $AJ_FAKE_TRANSFORMERS_LOG
// with the pid that did it, so a test can tell which process loaded the model.
import { appendFileSync } from "node:fs";

function record(entry) {
  const log = process.env.AJ_FAKE_TRANSFORMERS_LOG;
  if (log) appendFileSync(log, JSON.stringify({ pid: process.pid, ...entry }) + "\n");
}

record({ event: "import" });

// Four topics; a text's vector counts their mentions, so related texts land close.
const TOPICS = ["coffee", "sailing", "sqlite", "garden"];
function vec(text) {
  const t = text.toLowerCase();
  const v = TOPICS.map((k) => t.split(k).length - 1 + 0.01);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

export async function pipeline(task, model, opts = {}) {
  if (process.env.AJ_FAKE_TRANSFORMERS_FAIL) throw new Error("fake model failed to load");
  record({ event: "pipeline", task, model, dtype: opts.dtype });
  return async (texts) => {
    record({ event: "batch", n: texts.length });
    if (texts.some((t) => t.includes("CRASH"))) process.exit(3);
    return { tolist: () => texts.map(vec) };
  };
}
