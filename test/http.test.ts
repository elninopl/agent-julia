import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConfigSchema, ServerConfig } from "../src/config/schema.js";
import { migrate } from "../src/migrations/runner.js";
import { storePaths } from "../src/store/paths.js";
import { Indexer } from "../src/index/indexer.js";
import { ensureGitRepo } from "../src/store/git.js";
import { HttpHandle, ServerState, listenHttp, maintainAll, refuseSettings } from "../src/http/serve-http.js";
import { Runtime } from "../src/runtime.js";
import { managedBlock } from "../src/managed/block.js";
import { STARTUP_BLOCK_ID } from "../src/persona/startup.js";

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

const LOCAL: ServerConfig = { host: "127.0.0.1", port: 0, auth: "none", maintenanceEveryMinutes: 60 };

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function serve(opts: { git?: boolean } = {}): Promise<{ handle: HttpHandle; rt: Runtime; dir: string; home: string; state: ServerState }> {
  const home = mkdtempSync(join(tmpdir(), "aj-home-"));
  const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const dir = mkdtempSync(join(tmpdir(), "aj-http-"));
  const git = opts.git ?? false;
  if (git) await ensureGitRepo(dir);
  const config = ConfigSchema.parse({ memoryDir: dir, git, search: "fts" });
  await migrate(config, { persistConfig: false });
  const paths = storePaths(dir);
  const rt: Runtime = { config, paths, indexer: Indexer.open(paths, config) };
  const state = new ServerState();
  const handle = await listenHttp(rt, LOCAL, state);
  cleanup.push(async () => {
    await handle.close();
    rt.indexer.close();
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  return { handle, rt, dir, home, state };
}

async function connect(handle: HttpHandle, name = "test-client"): Promise<Client> {
  const client = new Client({ name, version: "test" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp`)));
  cleanup.push(() => client.close());
  return client;
}

describe("refusing to start", () => {
  it("without authentication anywhere but loopback", () => {
    expect(refuseSettings({ ...LOCAL, host: "0.0.0.0" })).toMatch(/binds loopback only/);
    expect(refuseSettings({ ...LOCAL, host: "192.168.1.10" })).toMatch(/binds loopback only/);
    expect(refuseSettings({ ...LOCAL, publicUrl: "https://memory.example.com" })).toMatch(/needs authentication/);
    expect(refuseSettings(LOCAL)).toBeNull();
    expect(refuseSettings({ ...LOCAL, host: "localhost" })).toBeNull();
    expect(refuseSettings({ ...LOCAL, host: "::1" })).toBeNull();
  });

  it("throws before binding anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-http-"));
    const config = ConfigSchema.parse({ memoryDir: dir, git: false, search: "fts" });
    const paths = storePaths(dir);
    const rt: Runtime = { config, paths, indexer: Indexer.open(paths, config) };
    cleanup.push(() => rt.indexer.close());
    await expect(listenHttp(rt, { ...LOCAL, host: "0.0.0.0" })).rejects.toThrow(/loopback only/);
  });
});

describe("the HTTP server", () => {
  it("answers an MCP client end to end", async () => {
    const { handle } = await serve();
    const client = await connect(handle);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["read", "search", "ingest", "get_core", "correct_voice"]));

    await client.callTool({ name: "ingest", arguments: { page: "atlas-app", content: "Trail app for hikers." } });
    expect(textOf(await client.callTool({ name: "search", arguments: { query: "hikers" } }))).toContain("atlas-app");
    expect(textOf(await client.callTool({ name: "get_core", arguments: {} }))).toContain("Julia");
    expect(handle.sessionCount()).toBe(1);
  });

  it("lands every write from two sessions writing at once", async () => {
    const { handle, dir } = await serve({ git: true });
    const a = await connect(handle, "client-a");
    const b = await connect(handle, "client-b");
    expect(handle.sessionCount()).toBe(2);

    const writes = (client: Client, who: string) =>
      Array.from({ length: 5 }, (_, i) =>
        client.callTool({ name: "ingest", arguments: { page: `${who}-${i}`, content: `Fact ${i} from ${who}.` } }),
      );
    const results = await Promise.all([...writes(a, "a"), ...writes(b, "b")]);
    for (const r of results) expect(JSON.parse(textOf(r)).ok).toBe(true);

    const subjects = execFileSync("git", ["log", "--format=%s"], { cwd: dir, encoding: "utf8" })
      .split("\n")
      .filter((l) => l.startsWith("Update memory:"));
    expect(subjects.length).toBe(10);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim()).toBe("");
    const catalog = readFileSync(join(dir, "index.md"), "utf8");
    for (const who of ["a", "b"]) for (let i = 0; i < 5; i++) expect(catalog).toContain(`${who}-${i}`);
  });

  it("never rewrites the Claude files of the machine it runs on", async () => {
    const { handle, home } = await serve();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const claudeMd = join(home, ".claude", "CLAUDE.md");
    const before = `# mine\n\n${managedBlock(STARTUP_BLOCK_ID, "an old persona")}\n`;
    writeFileSync(claudeMd, before);

    const client = await connect(handle);
    await client.callTool({ name: "correct_voice", arguments: { note: "No exclamation marks." } });
    expect(readFileSync(claudeMd, "utf8")).toBe(before);
  });

  it("refuses a Host it does not serve, and proxied requests without authentication", async () => {
    const { handle } = await serve();
    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } },
    };
    // node:http, not fetch: fetch drops a Host header it is handed.
    const post = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const body = JSON.stringify(init);
        const req = request(
          `${handle.url}/mcp`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "content-length": Buffer.byteLength(body),
              ...headers,
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    expect(await post({ host: "evil.example.com" })).toBe(403);
    expect(await post({ "x-forwarded-for": "203.0.113.7" })).toBe(403);
    expect(await post({})).toBe(200);
  });

  it("answers an unknown session with 404 so the client starts over", async () => {
    const { handle } = await serve();
    const res = await fetch(`${handle.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "not-a-session",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(res.status).toBe(404);
  });

  it("reports its stores and housekeeping on /healthz", async () => {
    const { handle, rt, state } = await serve({ git: true });
    const client = await connect(handle);
    await client.callTool({ name: "ingest", arguments: { page: "note", content: "Something." } });
    await maintainAll(rt, state);

    const res = await fetch(`${handle.url}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      version: string;
      sessions: number;
      stores: Array<{ name: string | null; lastWrite: string | null; lastMaintenance: { outcome: string } | null; git: unknown }>;
    };
    expect(body.ok).toBe(true);
    expect(body.sessions).toBe(1);
    expect(body.stores).toHaveLength(1);
    expect(body.stores[0]!.name).toBeNull();
    expect(body.stores[0]!.lastWrite).not.toBeNull();
    expect(body.stores[0]!.lastMaintenance?.outcome).toBe("maintained");
    expect(body.stores[0]!.git).toEqual({ remote: false, unpushed: null });
  });
});
