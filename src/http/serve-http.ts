import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { NextFunction, Request, Response } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ServerConfig, serverSettings } from "../config/schema.js";
import { Runtime, buildRuntime } from "../runtime.js";
import { StoreMaintenance, createMcpServer, packageVersion, primaryStore, pullAndMaintain } from "../server.js";
import { latestStoreMtime } from "../store/markdown.js";
import { unpushedCommits } from "../store/git.js";
import { waitForIdle } from "../store/lock.js";
import { log, warn } from "../util/log.js";

// How long a shutdown waits for an in-flight write before exiting anyway.
const DRAIN_MS = 5_000;
// A session nobody has used for this long is closed. Clients rarely send the
// DELETE that ends a session, and each one holds an McpServer.
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const SWEEP_MS = 5 * 60 * 1000;
// One ingest can carry a whole long page.
const BODY_LIMIT = "8mb";

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

// Why these settings must not start a server, or null when they may. With no
// authentication the server may only answer this machine: bound to loopback,
// and with no public URL that a reverse proxy would forward to it.
export function refuseSettings(s: ServerConfig): string | null {
  if (s.auth === "none") {
    if (!isLoopbackHost(s.host)) {
      return `server.auth is "none" and server.host is ${s.host}: without authentication the server binds loopback only`;
    }
    if (s.publicUrl) {
      return `server.auth is "none" and server.publicUrl is set: a server reachable from outside needs authentication`;
    }
    return null;
  }
  return `server.auth "${s.auth}" is not available in this version yet; use "none" on loopback`;
}

// What the HTTP server knows about its own housekeeping, for /healthz.
export class ServerState {
  readonly startedAt = new Date();
  readonly maintenance = new Map<string, StoreMaintenance>();
  maintaining = false;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
}

export interface HttpHandle {
  url: string;
  port: number;
  sessionCount(): number;
  close(): Promise<void>;
}

function rpcError(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

// The Host names a request may carry: loopback always, plus the public host
// when a reverse proxy forwards to this server. Checked before anything else,
// so a page in a browser cannot reach a loopback server through a DNS name it
// controls.
function allowedHosts(s: ServerConfig): string[] {
  const hosts = ["localhost", "127.0.0.1", "[::1]"];
  if (s.publicUrl) hosts.push(new URL(s.publicUrl).hostname);
  if (!isLoopbackHost(s.host) && !["0.0.0.0", "::"].includes(s.host)) hosts.push(s.host);
  return hosts;
}

// With no authentication, a request that came through a proxy is a request
// from outside this machine, whatever address it arrives from.
function localOnly(req: Request, res: Response, next: NextFunction): void {
  if (req.headers["x-forwarded-for"] || req.headers["forwarded"] || req.headers["x-real-ip"]) {
    rpcError(res, 403, "this server has no authentication and answers only clients on its own machine");
    return;
  }
  next();
}

export async function listenHttp(rt: Runtime, settings: ServerConfig, state = new ServerState()): Promise<HttpHandle> {
  const refusal = refuseSettings(settings);
  if (refusal) throw new Error(refusal);

  const app = express();
  app.disable("x-powered-by");
  app.use(hostHeaderValidation(allowedHosts(settings)));
  if (settings.auth === "none") app.use(localOnly);
  app.use(express.json({ limit: BODY_LIMIT }));

  const sessions = new Map<string, Session>();

  const closeSession = async (id: string): Promise<void> => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    await s.transport.close().catch(() => undefined);
    await s.server.close().catch(() => undefined);
  };

  // One McpServer per session, all over the one runtime: one index per store,
  // one embedding process, and the store lock to order their writes.
  app.post("/mcp", async (req: Request, res: Response) => {
    const id = req.header("mcp-session-id");
    let session = id ? sessions.get(id) : undefined;
    if (!session) {
      if (id) return rpcError(res, 404, "Session not found");
      if (!isInitializeRequest(req.body)) return rpcError(res, 400, "Bad Request: no session; send initialize first");
      const server = await createMcpServer(rt, { localSurfaces: false });
      const fresh: Session = {
        server,
        lastSeen: Date.now(),
        transport: new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, fresh);
          },
          onsessionclosed: (sid) => {
            void closeSession(sid);
          },
        }),
      };
      await server.connect(fresh.transport);
      session = fresh;
    }
    session.lastSeen = Date.now();
    await session.transport.handleRequest(req, res, req.body);
  });

  const existing = async (req: Request, res: Response) => {
    const id = req.header("mcp-session-id");
    const session = id ? sessions.get(id) : undefined;
    if (!session) return rpcError(res, id ? 404 : 400, id ? "Session not found" : "Bad Request: no session id");
    session.lastSeen = Date.now();
    await session.transport.handleRequest(req, res);
  };
  app.get("/mcp", existing);
  app.delete("/mcp", existing);

  app.get("/healthz", async (_req: Request, res: Response) => {
    const stores = await Promise.all(
      [primaryStore(rt), ...(rt.stores ?? [])].map(async (s) => {
        const mtime = await latestStoreMtime(s.paths).catch(() => 0);
        const maint = state.maintenance.get(s.name ?? "");
        return {
          name: s.name,
          write: s.write,
          lastWrite: mtime > 0 ? new Date(mtime).toISOString() : null,
          lastMaintenance: maint ? { at: maint.at, outcome: maint.outcome, ...(maint.error ? { error: maint.error } : {}) } : null,
          git: s.config.git
            ? { remote: Boolean(s.config.gitRemote), unpushed: s.config.gitRemote ? await unpushedCommits(s.paths.root) : null }
            : null,
        };
      }),
    );
    const failed = stores.some((s) => s.lastMaintenance?.outcome === "failed");
    res.status(200).json({
      ok: !failed,
      version: await packageVersion(),
      startedAt: state.startedAt.toISOString(),
      sessions: sessions.size,
      stores,
    });
  });

  const http: Server = await new Promise((resolve, reject) => {
    const srv = app.listen(settings.port, settings.host, () => resolve(srv));
    srv.once("error", reject);
  });

  const sweep = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, s] of sessions) if (s.lastSeen < cutoff) void closeSession(id);
  }, SWEEP_MS);
  sweep.unref?.();

  const port = (http.address() as AddressInfo).port;
  const shownHost = settings.host.includes(":") ? `[${settings.host}]` : settings.host;
  return {
    url: `http://${shownHost}:${port}`,
    port,
    sessionCount: () => sessions.size,
    close: async () => {
      clearInterval(sweep);
      await new Promise<void>((resolve) => http.close(() => resolve()));
      for (const id of [...sessions.keys()]) await closeSession(id);
      http.closeAllConnections?.();
    },
  };
}

// Pull and maintain every store, one after another. A run still going when the
// next one is due is not doubled up.
export async function maintainAll(rt: Runtime, state: ServerState): Promise<void> {
  if (state.maintaining) return;
  state.maintaining = true;
  try {
    for (const store of [primaryStore(rt), ...(rt.stores ?? [])]) {
      state.maintenance.set(store.name ?? "", await pullAndMaintain(store));
      try {
        await store.indexer.reembedIfStale();
      } catch (err) {
        warn(`re-embed${store.name ? ` of store "${store.name}"` : ""} failed (continuing):`, (err as Error).message);
      }
    }
  } finally {
    state.maintaining = false;
  }
}

// `agent-julia serve --http`: one long-running process for every session of
// every client. Unlike the stdio server it is not tied to a parent process, and
// it never touches the Claude files of the machine it runs on.
export async function startHttpServer(overrides: { host?: string; port?: number } = {}): Promise<void> {
  const rt = await buildRuntime();
  const settings: ServerConfig = { ...serverSettings(rt.config), ...overrides };
  const state = new ServerState();
  const handle = await listenHttp(rt, settings, state);
  log(
    `agent-julia serving "${rt.config.name}" over HTTP at ${handle.url}/mcp — memory: ${rt.config.memoryDir}` +
      (rt.stores?.length ? `, stores: ${rt.stores.map((s) => s.name).join(", ")}` : ""),
  );

  const timer = setInterval(() => void maintainAll(rt, state), settings.maintenanceEveryMinutes * 60_000);
  timer.unref?.();

  let down = false;
  const shutdown = (why: string) => {
    if (down) return;
    down = true;
    log(`shutting down (${why})`);
    clearInterval(timer);
    const deadline = setTimeout(() => process.exit(0), DRAIN_MS * 2);
    deadline.unref?.();
    void (async () => {
      try {
        await handle.close();
        await waitForIdle(DRAIN_MS);
      } finally {
        clearTimeout(deadline);
        try {
          for (const store of rt.stores ?? []) store.indexer.close();
          rt.indexer.close();
        } catch {
          // closing a db that is already gone is not worth a failed exit
        }
        process.exit(0);
      }
    })();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await maintainAll(rt, state);
}
