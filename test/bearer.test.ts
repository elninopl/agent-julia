import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConfigSchema, ServerConfig } from "../src/config/schema.js";
import { migrate } from "../src/migrations/runner.js";
import { storePaths } from "../src/store/paths.js";
import { Indexer } from "../src/index/indexer.js";
import { HttpHandle, ServerState, listenHttp } from "../src/http/serve-http.js";
import { StaticTokenVerifier, addToken, revokeToken } from "../src/http/tokens.js";
import { mountExtraStores } from "../src/store/stores.js";
import { Runtime } from "../src/runtime.js";

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

const BEARER: ServerConfig = { host: "127.0.0.1", port: 0, auth: "bearer", maintenanceEveryMinutes: 60 };

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function store(prefix: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  await migrate(ConfigSchema.parse({ memoryDir: dir, git: false, search: "fts" }), { persistConfig: false });
  return dir;
}

async function serve() {
  const home = mkdtempSync(join(tmpdir(), "aj-home-"));
  const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const own = await store("aj-own-");
  const team = await store("aj-team-");
  const config = ConfigSchema.parse({
    memoryDir: own,
    git: false,
    search: "fts",
    stores: [{ name: "team", dir: team, write: true, git: false }],
  });
  const paths = storePaths(own);
  const indexer = Indexer.open(paths, config);
  const stores = await mountExtraStores(config, { paths, indexer }, false);
  const rt: Runtime = { config, paths, indexer, stores };
  const file = join(mkdtempSync(join(tmpdir(), "aj-secrets-")), "tokens.json");
  const handle = await listenHttp(rt, BEARER, new ServerState(), { verifier: new StaticTokenVerifier(file) });
  cleanup.push(async () => {
    await handle.close();
    for (const s of stores) s.indexer.close();
    indexer.close();
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  return { handle, file };
}

async function connect(handle: HttpHandle, token: string): Promise<Client> {
  const client = new Client({ name: "t", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  cleanup.push(() => client.close());
  return client;
}

const initBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } },
});
const post = (handle: HttpHandle, headers: Record<string, string> = {}, body = initBody) =>
  fetch(`${handle.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body,
  });

describe("bearer tokens", () => {
  it("are stored hashed, in a file only the owner reads", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "aj-secrets-")), "tokens.json");
    const { token, record } = await addToken("laptop", undefined, file);
    expect(token).toMatch(/^aj_/);
    expect(record.hash).not.toContain(token);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    await expect(addToken("laptop", undefined, file)).rejects.toThrow(/exists/);
  });

  it("turn away a request with no token or a wrong one", async () => {
    const { handle, file } = await serve();
    await addToken("laptop", undefined, file);
    const none = await post(handle);
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toMatch(/^Bearer /);
    expect((await post(handle, { authorization: "Bearer aj_wrong" })).status).toBe(401);
  });

  it("let a valid token in, and stop working once revoked, without a restart", async () => {
    const { handle, file } = await serve();
    const { token } = await addToken("laptop", undefined, file);
    const client = await connect(handle, token);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);

    await revokeToken("laptop", file);
    await expect(client.listTools()).rejects.toThrow();
  });

  it("do not let a session be used with another client's token", async () => {
    const { handle, file } = await serve();
    const a = await addToken("full", undefined, file);
    const b = await addToken("narrow", ["team"], file);
    const opened = await post(handle, { authorization: `Bearer ${a.token}` });
    const sid = opened.headers.get("mcp-session-id")!;
    expect(sid).toBeTruthy();
    const hijack = await post(
      handle,
      { authorization: `Bearer ${b.token}`, "mcp-session-id": sid },
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    );
    expect(hijack.status).toBe(404);
  });

  it("limit a scoped token to its stores", async () => {
    const { handle, file } = await serve();
    const full = await connect(handle, (await addToken("owner", undefined, file)).token);
    await full.callTool({ name: "ingest", arguments: { page: "salary", content: "Private: my salary talk." } });
    await full.callTool({ name: "ingest", arguments: { page: "plan", content: "Shared: launch plan.", store: "team" } });

    const group = await connect(handle, (await addToken("group", ["team"], file)).token);
    expect(group.getInstructions()).toMatch(/team/);

    const listed = JSON.parse(textOf(await group.callTool({ name: "list", arguments: {} }))) as { pages: Array<{ id: string }> };
    expect(listed.pages.map((p) => p.id)).toEqual(["team:plan"]);
    expect(textOf(await group.callTool({ name: "search", arguments: { query: "salary" } }))).not.toContain("salary");
    expect(textOf(await group.callTool({ name: "read", arguments: { page: "salary" } }))).toBe("No page found: salary");

    const bare = JSON.parse(textOf(await group.callTool({ name: "ingest", arguments: { page: "x", content: "y" } })));
    expect(bare.ok).toBe(false);
    expect(bare.error).toMatch(/cannot write to the user's own memory/);
    const shared = JSON.parse(
      textOf(await group.callTool({ name: "ingest", arguments: { page: "x", content: "y", store: "team" } })),
    );
    expect(shared).toMatchObject({ ok: true, id: "team:x" });

    expect(textOf(await group.callTool({ name: "correct_voice", arguments: { note: "Be louder." } }))).toMatch(
      /cannot change the user's voice/,
    );
    expect(textOf(await group.callTool({ name: "get_core", arguments: {} }))).toContain("Julia");
  });

  it("show health details only to a token holder", async () => {
    const { handle, file } = await serve();
    const { token } = await addToken("monitor", undefined, file);
    const open = (await (await fetch(`${handle.url}/healthz`)).json()) as Record<string, unknown>;
    expect(Object.keys(open).sort()).toEqual(["ok", "version"]);
    const full = (await (
      await fetch(`${handle.url}/healthz`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { stores: unknown[] };
    expect(full.stores).toHaveLength(2);

    const { token: narrow } = await addToken("group", ["team"], file);
    const scoped = (await (
      await fetch(`${handle.url}/healthz`, { headers: { authorization: `Bearer ${narrow}` } })
    ).json()) as { stores: Array<{ name: string | null }> };
    expect(scoped.stores.map((s) => s.name)).toEqual(["team"]);
  });

  it("read no body before the token is checked, and answer a broken one in JSON", async () => {
    const { handle, file } = await serve();
    // Not JSON at all: without a token it is refused before anyone parses it.
    const stranger = await post(handle, {}, "{".repeat(1000));
    expect(stranger.status).toBe(401);

    const { token } = await addToken("owner", undefined, file);
    const broken = await post(handle, { authorization: `Bearer ${token}` }, "{ not json");
    expect(broken.status).toBe(400);
    expect(broken.headers.get("content-type")).toMatch(/json/);
    const text = await broken.text();
    expect(JSON.parse(text).error.message).toMatch(/not valid JSON/);
    expect(text).not.toMatch(/node_modules|at \w+ \(/);
  });

  it("search nothing, without failing, when the scope names no store mounted here", async () => {
    const { handle, file } = await serve();
    const ghost = await connect(handle, (await addToken("ghost", ["gone"], file)).token);
    const res = await ghost.callTool({ name: "search", arguments: { query: "anything" } });
    expect(res.isError).toBeFalsy();
  });

  it("refuse a store named like the primary in token scopes", () => {
    expect(() => ConfigSchema.parse({ memoryDir: "/m", stores: [{ name: "primary", dir: "/p" }] })).toThrow(/reserved/);
  });
});
