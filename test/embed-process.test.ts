import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmbedProcess } from "../src/index/embed-process.js";

// A URL, not a path: --import takes a specifier, and a Windows path is not one.
const HOOK = new URL("./fixtures/fake-transformers-hook.mjs", import.meta.url).href;

interface Entry {
  pid: number;
  event: "import" | "pipeline" | "batch";
  dtype?: string;
  n?: number;
}

function entries(log: string): Entry[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Entry);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("the local model runs in a child process", () => {
  let log: string;
  let proc: EmbedProcess | null = null;
  const saved = { ...process.env };

  beforeEach(() => {
    log = join(mkdtempSync(join(tmpdir(), "aj-embed-")), "fake.log");
    process.env.AJ_FAKE_TRANSFORMERS_LOG = log;
  });
  afterEach(() => {
    proc?.close();
    proc = null;
    process.env = { ...saved };
  });

  const start = (idleMs = 60_000) =>
    (proc = new EmbedProcess({ model: "fake/model", dtype: "q8", idleMs, execArgv: ["--import", HOOK] }));

  it("loads the model in the child, never here, in batches of at most 8", async () => {
    const p = start();
    const vectors = await p.embed(Array.from({ length: 19 }, (_, i) => `coffee note ${i}`));
    expect(vectors).toHaveLength(19);
    expect(vectors[0]).toHaveLength(4);

    const log_ = entries(log);
    expect(log_.some((e) => e.pid === process.pid)).toBe(false);
    expect(new Set(log_.map((e) => e.pid))).toEqual(new Set([p.pid]));
    expect(log_.find((e) => e.event === "pipeline")?.dtype).toBe("q8");
    expect(log_.filter((e) => e.event === "batch").map((e) => e.n)).toEqual([8, 8, 3]);
  });

  it("exits after the idle window and starts again on the next request", async () => {
    const p = start(150);
    await p.embed(["sailing"]);
    const first = p.pid!;
    await until(() => !alive(first));
    expect(p.pid).toBeNull();

    await p.embed(["sailing again"]);
    expect(p.pid).not.toBeNull();
    expect(p.pid).not.toBe(first);
  });

  it("stops the child on close", async () => {
    const p = start();
    await p.embed(["garden"]);
    const pid = p.pid!;
    p.close();
    await until(() => !alive(pid));
    await expect(p.embed(["garden"])).rejects.toThrow(/closed/);
  });

  it("survives a crashed child: the request fails, the next one gets a fresh process", async () => {
    const p = start();
    await expect(p.embed(["CRASH here"])).rejects.toThrow(/exited/);
    await expect(p.embed(["sqlite"])).resolves.toHaveLength(1);
  });

  it("stops asking once the model cannot load at all", async () => {
    process.env.AJ_FAKE_TRANSFORMERS_FAIL = "1";
    const p = start();
    await expect(p.embed(["coffee"])).rejects.toThrow(/failed to load/);
    const spawned = entries(log).length;
    await expect(p.embed(["coffee"])).rejects.toThrow(/failed to load/);
    // Answered from memory: no second child, no second import.
    expect(entries(log).length).toBe(spawned);
  });

  it("runs one request at a time", async () => {
    const p = start();
    const all = await Promise.all([p.embed(["coffee"]), p.embed(["sailing"]), p.embed(["sqlite", "garden"])]);
    expect(all.map((v) => v.length)).toEqual([1, 1, 2]);
    expect(entries(log).filter((e) => e.event === "pipeline")).toHaveLength(1);
  });
});
