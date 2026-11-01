import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigSchema, ServerConfig } from "../src/config/schema.js";
import { migrate } from "../src/migrations/runner.js";
import { storePaths } from "../src/store/paths.js";
import { Indexer } from "../src/index/indexer.js";
import { HttpHandle, ServerState, listenHttp } from "../src/http/serve-http.js";
import { StaticTokenVerifier, addToken } from "../src/http/tokens.js";
import {
  RemoteError,
  RemoteProxy,
  UpstreamLink,
  createRemoteProxy,
  fetchCore,
  normalizeRemoteUrl,
  resolveRemote,
} from "../src/remote/remote.js";
import { STARTUP_BLOCK_ID } from "../src/persona/startup.js";
import { upsertManagedBlock } from "../src/managed/block.js";
import { defaultTargets, runRemoteDoctor } from "../src/doctor/doctor.js";
import type { Runtime } from "../src/runtime.js";

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

const savedEnv = process.env.AGENT_JULIA_TOKEN;
delete process.env.AGENT_JULIA_TOKEN;
cleanup.push(() => {
  if (savedEnv !== undefined) process.env.AGENT_JULIA_TOKEN = savedEnv;
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

// The agent-julia server this machine connects to, in this process.
async function upstream() {
  const dir = tmp("aj-remote-store-");
  const config = ConfigSchema.parse({ memoryDir: dir, git: false, search: "fts" });
  await migrate(config, { persistConfig: false });
  const paths = storePaths(dir);
  const indexer = Indexer.open(paths, config);
  const rt: Runtime = { config, paths, indexer };
  const tokens = join(tmp("aj-remote-secrets-"), "tokens.json");
  const { token } = await addToken("laptop", undefined, tokens);
  const port = await freePort();
  const settings: ServerConfig = { host: "127.0.0.1", port, auth: "bearer", maintenanceEveryMinutes: 60 };
  const state = { handle: null as HttpHandle | null };
  const start = async () => {
    state.handle = await listenHttp(rt, settings, new ServerState(), { verifier: new StaticTokenVerifier(tokens) });
  };
  const stop = async () => {
    await state.handle?.close();
    state.handle = null;
  };
  await start();
  cleanup.push(async () => {
    await stop();
    indexer.close();
  });
  return { dir, token, url: `http://127.0.0.1:${port}/mcp`, start, stop };
}

// This machine: a config naming the server, a token file, and the files a
// local install would refresh.
function here(url: string, token: string | null) {
  const dir = tmp("aj-remote-here-");
  const tokenFile = join(dir, "remote-token");
  if (token) writeFileSync(tokenFile, `${token}\n`);
  const claudeMd = join(dir, "CLAUDE.md");
  const config = ConfigSchema.parse({ memoryDir: join(dir, "unused"), surfaces: ["code"], name: "Local", remote: { url } });
  return {
    config,
    tokenFile,
    claudeMd,
    opts: {
      tokenFile,
      cacheFile: join(dir, "remote-cache.json"),
      targets: [{ path: claudeMd, body: "core" as const }],
      skillsDir: null,
      lockRoot: dir,
    },
  };
}

async function attach(proxy: RemoteProxy): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await proxy.server.connect(a);
  const client = new Client({ name: "claude-code", version: "1" });
  await client.connect(b);
  cleanup.push(async () => {
    await client.close();
    await proxy.close();
  });
  return client;
}

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Windows reports a refused connection after its SYN retries, about two
// seconds, so the limits leave room for that and still catch a hang.
describe("remote client", { timeout: 30_000 }, () => {
  it("forwards tools, instructions and the core resource to the server", async () => {
    const up = await upstream();
    const me = here(up.url, up.token);
    const client = await attach(await createRemoteProxy(me.config, me.opts));

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_core", "search", "read", "ingest", "correct_voice"]));
    // The server's persona, not this machine's config.
    expect(client.getInstructions()).toContain("Julia");

    const saved = JSON.parse(
      textOf(await client.callTool({ name: "ingest", arguments: { page: "atlas", content: "Atlas launches in spring." } })),
    );
    expect(saved.ok).toBe(true);
    expect(saved).not.toHaveProperty("path");
    expect(existsSync(join(up.dir, "pages", "atlas.md"))).toBe(true);
    expect(textOf(await client.callTool({ name: "search", arguments: { query: "atlas spring" } }))).toContain("atlas");

    const core = await client.readResource({ uri: "agent-julia://core" });
    expect(core.contents[0]).toHaveProperty("text");
    expect(existsSync(me.config.memoryDir)).toBe(false);
  });

  it("refreshes the local persona block from the server's core, and again after a correction", async () => {
    const up = await upstream();
    const me = here(up.url, up.token);
    await upsertManagedBlock(me.claudeMd, STARTUP_BLOCK_ID, "an old core");
    const proxy = await createRemoteProxy(me.config, me.opts);
    const client = await attach(proxy);

    expect(await proxy.refreshLocalSurfaces()).toBe(1);
    const block = readFileSync(me.claudeMd, "utf8");
    expect(block).not.toContain("an old core");
    expect(block).toContain("agent-julia core ");

    const res = await client.callTool({ name: "correct_voice", arguments: { note: "Never open with a greeting." } });
    expect(res.isError).toBeFalsy();
    await until(() => readFileSync(me.claudeMd, "utf8").includes("Never open with a greeting."));
  });

  it("answers at once with an error naming the server when it is down", async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/mcp`;
    const me = here(url, "aj_whatever");
    const started = Date.now();
    const client = await attach(await createRemoteProxy(me.config, me.opts));
    expect((await client.listTools()).tools).toEqual([]);
    expect(client.getInstructions()).toContain("did not answer");

    const res = await client.callTool({ name: "search", arguments: { query: "x" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(url);
    expect(textOf(res)).toMatch(/cannot reach/);
    expect(textOf(res)).toContain("Nothing was done.");
    expect(Date.now() - started).toBeLessThan(12_000);
  });

  it("serves the tools it saw last while the server is away", async () => {
    const up = await upstream();
    const me = here(up.url, up.token);
    const first = await attach(await createRemoteProxy(me.config, me.opts));
    const seen = (await first.listTools()).tools.map((t) => t.name);
    await until(() => existsSync(me.opts.cacheFile));
    await up.stop();

    const again = await attach(await createRemoteProxy(me.config, me.opts));
    expect((await again.listTools()).tools.map((t) => t.name)).toEqual(seen);
    expect(again.getInstructions()).toContain("Julia");
  });

  it("opens a new session when the server restarts", async () => {
    const up = await upstream();
    const me = here(up.url, up.token);
    const client = await attach(await createRemoteProxy(me.config, me.opts));
    await client.callTool({ name: "ingest", arguments: { page: "one", content: "First page." } });

    await up.stop();
    // A restart takes a moment, in which this side sees its kept-alive
    // connections closed. Both ends share one process here, so wait for it.
    await new Promise((r) => setTimeout(r, 200));
    await up.start();

    const res = await client.callTool({ name: "ingest", arguments: { page: "two", content: "Second page." } });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(existsSync(join(up.dir, "pages", "two.md"))).toBe(true);
  });

  it("sends a read again after a broken connection, and never a write", async () => {
    const up = await upstream();
    const me = here(up.url, up.token);
    const link = new UpstreamLink(await resolveRemote(me.config, undefined, me.tokenFile));
    cleanup.push(() => link.close());
    const reset = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    let calls = 0;
    const flaky = async (c: Client) => {
      calls++;
      if (calls === 1) throw reset();
      return (await c.listTools()).tools.length;
    };

    expect(await link.use(flaky, { repeatable: true })).toBeGreaterThan(0);
    expect(calls).toBe(2);

    calls = 0;
    const err = (await link.use(flaky).catch((e: unknown) => e)) as RemoteError;
    expect(calls).toBe(1);
    expect(err).toBeInstanceOf(RemoteError);
    expect(err.mayHaveRun).toBe(true);
    expect(err.message).toMatch(/ECONNRESET/);
  });

  it("says when the token is refused", async () => {
    const up = await upstream();
    const me = here(up.url, "aj_wrong");
    const client = await attach(await createRemoteProxy(me.config, me.opts));
    const res = await client.callTool({ name: "search", arguments: { query: "x" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/refused the token \(401\)/);
  });

  it("gets the persona's identity along with the core", async () => {
    const up = await upstream();
    const me = here(up.url, up.token);
    const link = new UpstreamLink(await resolveRemote(me.config, undefined, me.tokenFile));
    try {
      const core = await fetchCore(link);
      expect(core.identity).toMatchObject({ name: "Julia", pronouns: "she/her" });
    } finally {
      await link.close();
    }
  });

  it("takes the token from the environment first, then the file", async () => {
    const me = here("https://julia.example.com", "aj_from_file");
    expect((await resolveRemote(me.config, undefined, me.tokenFile)).token).toBe("aj_from_file");
    process.env.AGENT_JULIA_TOKEN = "aj_from_env";
    try {
      const t = await resolveRemote(me.config, undefined, me.tokenFile);
      expect(t).toMatchObject({ token: "aj_from_env", tokenSource: "$AGENT_JULIA_TOKEN" });
      expect(t.url.href).toBe("https://julia.example.com/mcp");
    } finally {
      delete process.env.AGENT_JULIA_TOKEN;
    }
    expect(normalizeRemoteUrl("http://studio.local:8787/custom").pathname).toBe("/custom");
  });

  it("doctor checks the way to the server and the version on both sides", async () => {
    const up = await upstream();
    const me = here(up.url, up.token);
    const targets = { ...defaultTargets(), claudeCodeConfig: join(me.opts.lockRoot, "claude.json"), claudeCodeMemory: me.claudeMd, desktopConfig: null };
    const checks = await runRemoteDoctor(me.config, targets, { tokenFile: me.tokenFile });
    const by = Object.fromEntries(checks.map((c) => [c.name, c.status]));
    expect(by).toMatchObject({ server: "ok", auth: "ok", version: "ok", "mcp (code)": "fail", "persona (code)": "fail" });

    await up.stop();
    const down = await runRemoteDoctor(me.config, targets, { tokenFile: me.tokenFile });
    expect(down.find((c) => c.name === "server")?.status).toBe("fail");
  });
});
