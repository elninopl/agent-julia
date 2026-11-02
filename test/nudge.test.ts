import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigSchema } from "../src/config/schema.js";
import { migrate } from "../src/migrations/runner.js";
import { storePaths } from "../src/store/paths.js";
import { Indexer } from "../src/index/indexer.js";
import { registerTools } from "../src/tools/register.js";
import { NUDGE_AFTER_MS } from "../src/tools/nudge.js";

type Content = Array<{ type: string; text?: string }>;

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function session(serverNudge: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "aj-nudge-"));
  const config = ConfigSchema.parse({ memoryDir: dir, git: false, search: "fts", capture: { serverNudge } });
  await migrate(config, { persistConfig: false });
  const paths = storePaths(dir);
  const indexer = Indexer.open(paths, config);
  const clock = { t: 1_000_000 };
  const server = new McpServer({ name: "agent-julia", version: "test" });
  registerTools(server, { config, paths, indexer }, { localSurfaces: false, now: () => clock.t });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  cleanup.push(async () => {
    await client.close();
    await server.close();
    indexer.close();
  });
  const call = async (name: string, args: Record<string, unknown>) =>
    ((await client.callTool({ name, arguments: args })).content as Content);
  return { clock, call };
}

const nudged = (content: Content) => content.some((c) => /nothing saved in this session/.test(c.text ?? ""));

describe("server nudge", () => {
  it("asks once, after a long stretch of reading with nothing saved", async () => {
    const { clock, call } = await session(true);
    await call("ingest", { page: "atlas", content: "Atlas launches in March." });
    expect(nudged(await call("search", { query: "atlas" }))).toBe(false);
    expect(nudged(await call("read", { page: "atlas" }))).toBe(false);

    clock.t += NUDGE_AFTER_MS + 60_000;
    const third = await call("list", {});
    expect(nudged(third)).toBe(true);
    // The result itself is untouched: still JSON in the first item.
    expect(() => JSON.parse(third[0]!.text!)).not.toThrow();
    expect(third.at(-1)!.text).toMatch(/21 min/);

    expect(nudged(await call("search", { query: "atlas" }))).toBe(false);

    await call("ingest", { page: "atlas", content: "Atlas moves to April.", mode: "append" });
    clock.t += NUDGE_AFTER_MS + 60_000;
    expect(nudged(await call("search", { query: "atlas" }))).toBe(false);
  });

  it("stays quiet when serverNudge is off", async () => {
    const { clock, call } = await session(false);
    clock.t += 10 * NUDGE_AFTER_MS;
    for (let i = 0; i < 5; i++) expect(nudged(await call("search", { query: "anything" }))).toBe(false);
  });
});
