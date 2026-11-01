import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CallToolResult,
  ErrorCode,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { configPath } from "../config/config.js";
import { Config } from "../config/schema.js";
import { writeSecretFile, secretsDir } from "../http/tokens.js";
import { IDENTITY_META, Identity, packageVersion, startParentWatchdog } from "../server.js";
import { injectedCoreFrom, serverInstructions } from "../persona/startup.js";
import { RefreshTarget, claudeCodeMemoryPath, coworkMirrorPath, refreshInjectedCore } from "../wizard/register.js";
import { installSkills, skillsTargetDir } from "../skills/install.js";
import { refreshHookScript } from "../hooks/hooks.js";
import { withStoreLock } from "../store/lock.js";
import { log, warn } from "../util/log.js";

export const CORE_URI = "agent-julia://core";

// A Claude session waits on the first answer, so a server that is down must
// cost seconds, not the client's own minute-long timeout.
const CONNECT_TIMEOUT_MS = 8_000;
const LIST_TIMEOUT_MS = 15_000;
// An ingest embeds the page on the server; a cold model can take a while.
const CALL_TIMEOUT_MS = 90_000;
// While the server is away: how often to try again, in the background and on
// demand.
const RETRY_MS = 30_000;

// Tools whose success changes the voice, after which the local persona block
// is refreshed the way the local server does it.
const VOICE_TOOLS = new Set(["correct_voice", "retract_correction"]);

export function remoteTokenFile(): string {
  return join(secretsDir(), "remote-token");
}

export function remoteCacheFile(): string {
  return join(dirname(configPath()), "remote-cache.json");
}

export interface RemoteTarget {
  url: URL;
  token: string | null;
  // Where the token came from, for doctor: "$AGENT_JULIA_TOKEN" or a file.
  tokenSource: string | null;
}

// A bare origin means its /mcp.
export function normalizeRemoteUrl(raw: string): URL {
  const url = new URL(raw.trim());
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/mcp";
  return url;
}

// The server to relay to and the token to show it: the environment variable
// named in the config first, then the token file the wizard wrote. Never the
// config itself.
export async function resolveRemote(config: Config, urlOverride?: string, tokenFile = remoteTokenFile()): Promise<RemoteTarget> {
  const raw = urlOverride ?? config.remote?.url;
  if (!raw) throw new Error("no server to connect to: set remote.url in the config or pass --remote <url>");
  const url = normalizeRemoteUrl(raw);
  const envName = config.remote?.tokenEnv ?? "AGENT_JULIA_TOKEN";
  const fromEnv = process.env[envName]?.trim();
  if (fromEnv) return { url, token: fromEnv, tokenSource: `$${envName}` };
  if (existsSync(tokenFile)) {
    const fromFile = (await readFile(tokenFile, "utf8")).trim();
    if (fromFile) return { url, token: fromFile, tokenSource: tokenFile };
  }
  return { url, token: null, tokenSource: null };
}

export async function saveRemoteToken(token: string, file = remoteTokenFile()): Promise<void> {
  await writeSecretFile(file, `${token.trim()}\n`);
}

// A failure to reach the server, worded for the person reading the tool
// result. Distinct from an error the server itself returned. `mayHaveRun`:
// the request may have reached the server before the failure, so a write
// may have gone through.
export class RemoteError extends Error {
  constructor(
    message: string,
    readonly mayHaveRun = false,
  ) {
    super(message);
  }
}

function networkCode(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: string; errors?: Array<{ code?: string }> } })?.cause;
  return cause?.code ?? cause?.errors?.find((e) => e.code)?.code;
}

export function describeFailure(url: URL, err: unknown): string {
  const where = `the agent-julia server at ${url.href}`;
  if (err instanceof RemoteError) return err.message;
  if (err instanceof StreamableHTTPError) {
    if (err.code === 401) return `${where} refused the token (401). Set a valid one: agent-julia init, or the AGENT_JULIA_TOKEN variable`;
    if (err.code === 403) return `${where} refused the request (403): ${err.message}`;
    if (err.code === 404) return `${where} has no MCP endpoint there (404); the address usually ends in /mcp`;
    return `${where} answered ${err.code}: ${err.message}`;
  }
  if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
    return `${where} did not answer in time; the request may still complete there`;
  }
  const code = networkCode(err);
  if (code) return `cannot reach ${where} (${code})`;
  return `${where}: ${(err as Error)?.message ?? String(err)}`;
}

export async function connectRemote(target: RemoteTarget, timeoutMs = CONNECT_TIMEOUT_MS): Promise<Client> {
  const client = new Client({ name: "agent-julia-remote", version: await packageVersion() });
  const transport = new StreamableHTTPClientTransport(target.url, {
    requestInit: target.token ? { headers: { authorization: `Bearer ${target.token}` } } : {},
    reconnectionOptions: { maxReconnectionDelay: 30_000, initialReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 2, maxRetries: 2 },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.connect(transport, { timeout: timeoutMs }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
      }),
    ]);
    return client;
  } catch (err) {
    await client.close().catch(() => undefined);
    throw new RemoteError(describeFailure(target.url, err));
  } finally {
    clearTimeout(timer);
  }
}

// A request that never reached the server, so sending it again cannot do a
// write twice: the session expired or the server restarted (404), or nothing
// was listening (connection refused).
function safeToRetry(err: unknown): boolean {
  if (err instanceof StreamableHTTPError) return err.code === 404;
  return networkCode(err) === "ECONNREFUSED";
}

// Failures that happen before a request can leave this machine.
const NOT_SENT = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN", "UND_ERR_CONNECT_TIMEOUT",
]);

// The request may have reached the server and run there: the connection
// broke after it was sent (or on a kept-alive connection the server had
// already closed, which looks the same from here), no answer came in time,
// or the server failed while answering.
function mayHaveRun(err: unknown): boolean {
  if (err instanceof McpError) return err.code === ErrorCode.RequestTimeout || err.code === ErrorCode.ConnectionClosed;
  if (err instanceof StreamableHTTPError) return err.code === 500 || err.code === 504;
  const code = networkCode(err);
  return code !== undefined && !NOT_SENT.has(code);
}

// Worth one more try on a fresh connection when the call is safe to repeat:
// the connection broke. Not a timeout, which would only double the wait.
function brokenConnection(err: unknown): boolean {
  if (err instanceof McpError) return err.code === ErrorCode.ConnectionClosed;
  const code = networkCode(err);
  return code !== undefined && !NOT_SENT.has(code);
}

function linkBroken(err: unknown): boolean {
  return err instanceof StreamableHTTPError || networkCode(err) !== undefined;
}

// One connection to the server, opened again when it is lost. Callers never
// wait on a server known to be down for longer than one connect attempt every
// RETRY_MS.
export class UpstreamLink {
  private client: Client | null = null;
  private pending: Promise<Client> | null = null;
  private failure: { at: number; error: RemoteError } | null = null;
  onConnect?: (client: Client) => void;

  constructor(readonly target: RemoteTarget) {}

  get connected(): boolean {
    return this.client !== null;
  }

  get lastError(): string | null {
    return this.failure?.error.message ?? null;
  }

  async get(force = false): Promise<Client> {
    if (this.client) return this.client;
    if (this.pending) return this.pending;
    if (!force && this.failure && Date.now() - this.failure.at < RETRY_MS) throw this.failure.error;
    this.pending = connectRemote(this.target)
      .then(
        (client) => {
          this.client = client;
          this.failure = null;
          client.onclose = () => {
            if (this.client === client) this.client = null;
          };
          this.onConnect?.(client);
          return client;
        },
        (err: RemoteError) => {
          this.failure = { at: Date.now(), error: err };
          throw err;
        },
      )
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  private async drop(): Promise<void> {
    const client = this.client;
    this.client = null;
    await client?.close().catch(() => undefined);
  }

  // `repeatable`: the call reads, or doing it twice equals doing it once, so
  // it may be sent again after a connection broke mid-way.
  async use<T>(fn: (client: Client) => Promise<T>, opts: { repeatable?: boolean } = {}): Promise<T> {
    const client = await this.get();
    try {
      return await fn(client);
    } catch (err) {
      // An error the server returned on purpose belongs to the caller as is.
      if (err instanceof McpError && err.code !== ErrorCode.RequestTimeout && err.code !== ErrorCode.ConnectionClosed) throw err;
      if (!safeToRetry(err) && !(opts.repeatable && brokenConnection(err))) {
        if (linkBroken(err) || brokenConnection(err)) await this.drop();
        throw new RemoteError(describeFailure(this.target.url, err), mayHaveRun(err));
      }
      await this.drop();
      const again = await this.get(true);
      try {
        return await fn(again);
      } catch (retryErr) {
        if (retryErr instanceof McpError && retryErr.code !== ErrorCode.RequestTimeout && retryErr.code !== ErrorCode.ConnectionClosed) throw retryErr;
        if (linkBroken(retryErr) || brokenConnection(retryErr)) await this.drop();
        // A first attempt that may have run still may have.
        throw new RemoteError(describeFailure(this.target.url, retryErr), mayHaveRun(err) || mayHaveRun(retryErr));
      }
    }
  }

  async close(): Promise<void> {
    await this.drop();
  }
}

export interface CoreSnapshot {
  text: string;
  identity: Identity | null;
}

export async function fetchCore(link: UpstreamLink): Promise<CoreSnapshot> {
  const res = await link.use((c) => c.readResource({ uri: CORE_URI }, { timeout: LIST_TIMEOUT_MS }), { repeatable: true });
  const content = res.contents[0];
  const text = content && "text" in content ? String(content.text) : "";
  if (!text.trim()) throw new RemoteError(`the agent-julia server at ${link.target.url.href} returned an empty persona core`);
  const identity = (content?._meta?.[IDENTITY_META] as Identity | undefined) ?? null;
  return { text, identity };
}

// The config with the server's persona identity in it: what the pasted Desktop
// block and the offline instructions are made from.
export function withIdentity(config: Config, identity: Identity | null): Config {
  return identity ? { ...config, ...identity } : config;
}

// What `sync` and the wizard install on a machine that connects to a server:
// the config with the server's persona identity, and the persona block built
// from the server's core.
export async function remoteInstallInputs(config: Config, tokenFile?: string): Promise<{ config: Config; core: string }> {
  const link = new UpstreamLink(await resolveRemote(config, undefined, tokenFile));
  try {
    const core = await fetchCore(link);
    return { config: withIdentity(config, core.identity), core: injectedCoreFrom(core.text) };
  } finally {
    await link.close();
  }
}

interface RemoteCache {
  url: string;
  serverVersion?: string;
  instructions?: string;
  tools?: Tool[];
  savedAt: string;
}

async function readCache(file: string, url: URL): Promise<RemoteCache | null> {
  try {
    const cache = JSON.parse(await readFile(file, "utf8")) as RemoteCache;
    return cache.url === url.href ? cache : null;
  } catch {
    return null;
  }
}

async function saveCache(file: string, cache: Omit<RemoteCache, "savedAt">): Promise<void> {
  try {
    await writeSecretFile(file, JSON.stringify({ ...cache, savedAt: new Date().toISOString() }, null, 2) + "\n");
  } catch (err) {
    warn("could not save the remote cache:", (err as Error).message);
  }
}

function offlineInstructions(config: Config, url: URL): string {
  return (
    `${serverInstructions(config)}\n\n` +
    `The agent-julia server at ${url.href} did not answer when this session started. ` +
    "Memory tools return an error until it does; tell the user if they rely on memory."
  );
}

export interface RemoteProxy {
  server: Server;
  link: UpstreamLink;
  // The persona block in the local Claude files and the shipped skills, from
  // the server's core. Resolves to the number of blocks rewritten, or null
  // when the server could not be reached.
  refreshLocalSurfaces(opts?: { skills?: boolean }): Promise<number | null>;
  close(): Promise<void>;
}

export interface RemoteProxyOptions {
  urlOverride?: string;
  cacheFile?: string;
  tokenFile?: string;
  targets?: RefreshTarget[];
  skillsDir?: string | null;
  lockRoot?: string;
}

// The stdio side of a remote client: an MCP server with no store of its own,
// forwarding tools, resources and instructions to an agent-julia server.
export async function createRemoteProxy(config: Config, opts: RemoteProxyOptions = {}): Promise<RemoteProxy> {
  const target = await resolveRemote(config, opts.urlOverride, opts.tokenFile);
  const cacheFile = opts.cacheFile ?? remoteCacheFile();
  const link = new UpstreamLink(target);
  const cache = await readCache(cacheFile, target.url);

  let first: Client | null = null;
  try {
    first = await link.get();
  } catch (err) {
    warn((err as Error).message);
  }
  const instructions = first?.getInstructions() ?? cache?.instructions ?? offlineInstructions(config, target.url);

  const server = new Server(
    { name: "agent-julia", version: await packageVersion() },
    { capabilities: { tools: { listChanged: true }, resources: {} }, instructions },
  );

  let lastTools: Tool[] | null = cache?.tools ?? null;
  let servedTools: string | null = null;

  const remember = async (client: Client, tools: Tool[]) => {
    lastTools = tools;
    await saveCache(cacheFile, {
      url: target.url.href,
      serverVersion: client.getServerVersion()?.version,
      instructions: client.getInstructions() ?? instructions,
      tools,
    });
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const { tools, client } = await link.use(
        async (c) => ({ tools: (await c.listTools(undefined, { timeout: LIST_TIMEOUT_MS })).tools, client: c }),
        { repeatable: true },
      );
      void remember(client, tools);
      servedTools = JSON.stringify(tools);
      return { tools };
    } catch (err) {
      warn(describeFailure(target.url, err));
      const tools = lastTools ?? [];
      servedTools = JSON.stringify(tools);
      return { tools };
    }
  });

  const block = { pending: null as Promise<number | null> | null };
  const refreshLocalSurfaces = async (o: { skills?: boolean } = {}): Promise<number | null> => {
    let core: CoreSnapshot;
    try {
      core = await fetchCore(link);
    } catch (err) {
      warn(`persona refresh skipped: ${(err as Error).message}`);
      return null;
    }
    const cfg = withIdentity(config, core.identity);
    const targets = opts.targets ?? [
      { path: claudeCodeMemoryPath(), body: "core" as const },
      { path: coworkMirrorPath(), body: "paste" as const },
    ];
    const skillsDir = opts.skillsDir === undefined ? skillsTargetDir() : opts.skillsDir;
    const done = await withStoreLock(
      opts.lockRoot ?? dirname(configPath()),
      async () => {
        const steps = o.skills && skillsDir ? await installSkills(skillsDir) : [];
        if (o.skills) await refreshHookScript(config).catch(() => false);
        const cores = await refreshInjectedCore(cfg, targets, injectedCoreFrom(core.text));
        return { steps, cores };
      },
      { name: "refresh" },
    );
    if (!done) {
      log("refresh: another agent-julia process was doing it — skipped");
      return 0;
    }
    if (o.skills) {
      log(`refresh: ${done.steps.filter((s) => s.status === "done").length}/${done.steps.length} skill(s), ${done.cores} persona block(s)`);
    }
    return done.cores;
  };

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    try {
      // What the server says of its own tool: reads and repeatable writes
      // may be sent again after a broken connection, other writes may not.
      const hints = lastTools?.find((t) => t.name === req.params.name)?.annotations;
      const repeatable = hints?.readOnlyHint === true || hints?.idempotentHint === true;
      const result = (await link.use((c) => c.callTool(req.params, undefined, { timeout: CALL_TIMEOUT_MS }), { repeatable })) as CallToolResult;
      if (VOICE_TOOLS.has(req.params.name) && !result.isError) {
        // Same as the local server: a correction reaches the next session's
        // persona block without waiting for a reboot.
        block.pending = refreshLocalSurfaces().catch(() => null);
      }
      return result;
    } catch (err) {
      if (err instanceof McpError) throw err;
      const outcome =
        err instanceof RemoteError && err.mayHaveRun
          ? "It may have gone through all the same: check with read or search before trying it again."
          : "Nothing was done.";
      return { content: [{ type: "text", text: `${(err as Error).message}. ${outcome}` }], isError: true };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async (req) => {
    try {
      return await link.use((c) => c.listResources(req.params, { timeout: LIST_TIMEOUT_MS }), { repeatable: true });
    } catch {
      return { resources: [] };
    }
  });
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (req) => {
    try {
      return await link.use((c) => c.listResourceTemplates(req.params, { timeout: LIST_TIMEOUT_MS }), { repeatable: true });
    } catch {
      return { resourceTemplates: [] };
    }
  });
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    try {
      return await link.use((c) => c.readResource(req.params, { timeout: LIST_TIMEOUT_MS }), { repeatable: true });
    } catch (err) {
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InternalError, (err as Error).message);
    }
  });

  // Back after an outage, or on a restarted server: if the tools are not the
  // ones this session was given, say so, and the client lists them again.
  link.onConnect = (client) => {
    void (async () => {
      try {
        const { tools } = await client.listTools(undefined, { timeout: LIST_TIMEOUT_MS });
        await remember(client, tools);
        if (servedTools !== null && JSON.stringify(tools) !== servedTools) await server.sendToolListChanged();
      } catch {
        // the next request will find out
      }
    })();
  };

  const retry = setInterval(() => {
    if (!link.connected) link.get(true).catch(() => undefined);
  }, RETRY_MS);
  retry.unref?.();

  return {
    server,
    link,
    refreshLocalSurfaces,
    close: async () => {
      clearInterval(retry);
      await block.pending;
      await link.close();
      await server.close().catch(() => undefined);
    },
  };
}

// `agent-julia serve` on a machine whose config names a server: stdio towards
// the Claude app, HTTP towards the server. No store, no index, no git here.
export async function startRemoteProxy(config: Config, urlOverride?: string): Promise<void> {
  const proxy = await createRemoteProxy(config, urlOverride ? { urlOverride } : {});

  let down = false;
  const shutdown = (why: string) => {
    if (down) return;
    down = true;
    log(`shutting down (${why})`);
    const deadline = setTimeout(() => process.exit(0), 3_000);
    deadline.unref?.();
    void proxy.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.stdin.on("end", () => shutdown("stdin ended"));
  process.stdin.on("close", () => shutdown("stdin closed"));

  const transport = new StdioServerTransport();
  const priorOnClose = transport.onclose;
  transport.onclose = () => {
    priorOnClose?.();
    shutdown("transport closed");
  };
  await proxy.server.connect(transport);
  log(
    `agent-julia relaying "${config.name}" to ${proxy.link.target.url.href}` +
      (proxy.link.connected ? "" : ` — not reachable yet (${proxy.link.lastError}); retrying every ${RETRY_MS / 1000} s`),
  );
  startParentWatchdog(() => shutdown("the client that started this server is gone"));

  await proxy.refreshLocalSurfaces({ skills: true });
}
