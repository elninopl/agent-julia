import { ChildProcess, fork } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The local model runs in a child process that exists only while it is in use.
// ONNX Runtime allocates natively and does not hand that memory back to the
// system while its process lives — not after a GC, not after dispose(). Loaded
// into the server itself, one search pinned 1.3-5.4 GB for the rest of the
// session, and every Claude session runs its own server: fifty open sessions
// filled the swap. A child that exits after a quiet minute returns all of it,
// and the next search pays ~0.7 s to start it again.
const IDLE_MS = 60_000;
// The first request to a fresh child may include the one-time model download.
const COLD_TIMEOUT_MS = 10 * 60_000;
const WARM_TIMEOUT_MS = 2 * 60_000;

interface Reply {
  id: number;
  vectors?: number[][];
  error?: string;
  // The model cannot be loaded at all (package missing, download failed).
  fatal?: boolean;
}

interface Pending {
  id: number;
  resolve: (vectors: number[][]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface EmbedProcessOptions {
  model: string;
  dtype: string;
  idleMs?: number;
  // Extra node flags for the child, after the inherited ones.
  execArgv?: string[];
}

export class EmbedProcess {
  private child: ChildProcess | null = null;
  private warm = false;
  private pending: Pending | null = null;
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private unavailable: Error | null = null;
  private closed = false;

  constructor(private readonly opts: EmbedProcessOptions) {}

  // The running child, if any.
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  // One request at a time: the child holds one model, and two batches running
  // in it at once would add their peaks together.
  embed(texts: string[]): Promise<number[][]> {
    const run = this.queue.then(() => this.send(texts));
    this.queue = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.closed = true;
    this.stop(new Error("the embedding process was closed"));
  }

  private send(texts: string[]): Promise<number[][]> {
    if (this.unavailable) return Promise.reject(this.unavailable);
    if (this.closed) return Promise.reject(new Error("the embedding process was closed"));
    this.cancelIdle();
    const child = this.child ?? this.spawn();
    child.ref();
    child.channel?.ref();
    return new Promise<number[][]>((resolve, reject) => {
      const id = this.nextId++;
      const ms = this.warm ? WARM_TIMEOUT_MS : COLD_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.stop(new Error(`the embedding process did not answer within ${ms / 1000} s`));
      }, ms);
      this.pending = { id, resolve, reject, timer };
      child.send({ id, texts }, (err) => {
        if (err) this.stop(err);
      });
    }).finally(() => this.scheduleIdle());
  }

  private spawn(): ChildProcess {
    const entry = workerEntry();
    const child = fork(entry.path, [this.opts.model, this.opts.dtype], {
      // The parent's stdout is the MCP channel. Nothing the model prints may reach it.
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      execArgv: [...entry.execArgv, ...(this.opts.execArgv ?? [])],
      serialization: "advanced",
    });
    child.on("message", (m: Reply) => {
      if (m.error !== undefined) {
        const err = new Error(m.error);
        // Same as the in-process loader before it: a model that cannot load is
        // not retried for the rest of the session.
        if (m.fatal) this.unavailable = err;
        this.settle(m.id, err);
        return;
      }
      this.warm = true;
      this.settle(m.id, m.vectors ?? []);
    });
    const gone = (why: Error): void => {
      if (this.child !== child) return;
      this.child = null;
      this.warm = false;
      this.cancelIdle();
      if (this.pending) this.settle(this.pending.id, why);
    };
    child.on("exit", (code, signal) => gone(new Error(`the embedding process exited (${signal ?? `code ${code}`})`)));
    child.on("error", (err) => gone(err));
    this.child = child;
    return child;
  }

  private settle(id: number, result: number[][] | Error): void {
    const p = this.pending;
    if (!p || p.id !== id) return;
    this.pending = null;
    clearTimeout(p.timer);
    if (result instanceof Error) p.reject(result);
    else p.resolve(result);
  }

  private scheduleIdle(): void {
    if (this.pending || !this.child) return;
    // An idle child must not keep a CLI command from exiting.
    this.child.unref();
    this.child.channel?.unref();
    this.idleTimer = setTimeout(() => this.stop(), this.opts.idleMs ?? IDLE_MS);
    this.idleTimer.unref?.();
  }

  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private stop(why?: Error): void {
    this.cancelIdle();
    const child = this.child;
    this.child = null;
    this.warm = false;
    if (this.pending) this.settle(this.pending.id, why ?? new Error("the embedding process was stopped"));
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
  }
}

// The built worker sits next to this file. Run from source (tsx, vitest), it is
// TypeScript and needs a loader the parent may not have been started with.
function workerEntry(): { path: string; execArgv: string[] } {
  // A debugger flag would have the child fight the parent for its port.
  const inherited = process.execArgv.filter((a) => !a.startsWith("--inspect"));
  const js = fileURLToPath(new URL("./embed-worker.js", import.meta.url));
  if (existsSync(js)) return { path: js, execArgv: inherited };
  const ts = fileURLToPath(new URL("./embed-worker.ts", import.meta.url));
  const loader = inherited.some((a) => a.includes("tsx")) ? [] : ["--import", "tsx"];
  return { path: ts, execArgv: [...inherited, ...loader] };
}
