import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../src/tools/register.js";
import { Indexer } from "../src/index/indexer.js";
import { storePaths } from "../src/store/paths.js";
import { migrate } from "../src/migrations/runner.js";
import { ConfigSchema } from "../src/config/schema.js";

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

// Drives the real registered tools over the MCP protocol via an in-memory
// transport — the same path a Claude client uses, minus the process boundary.
describe("MCP tool round-trip", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await cleanup?.();
  });

  it("lists tools and runs ingest -> search -> get_core end to end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-mcp-"));
    const config = ConfigSchema.parse({ memoryDir: dir, git: false, search: "fts", name: "Julia" });
    await migrate(config);
    const paths = storePaths(dir);
    const indexer = Indexer.open(paths, config);

    const server = new McpServer({ name: "agent-julia", version: "test" });
    registerTools(server, { config, paths, indexer });

    const client = new Client({ name: "test-client", version: "test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanup = async () => {
      await client.close();
      indexer.close();
    };

    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ["read", "list", "search", "ingest", "correct_voice", "maintenance", "get_core"]) {
      expect(tools).toContain(name);
    }

    await client.callTool({
      name: "ingest",
      arguments: { page: "atlas-app", content: "Trail app for hikers, marketed on Reddit." },
    });

    const hits = textOf(await client.callTool({ name: "search", arguments: { query: "hikers reddit" } }));
    expect(hits).toContain("atlas-app");

    const page = textOf(await client.callTool({ name: "read", arguments: { page: "atlas-app" } }));
    expect(page).toContain("Trail app for hikers");

    const core = textOf(await client.callTool({ name: "get_core", arguments: {} }));
    expect(core).toContain("Julia");
  });

  it("correct_voice shows what it stored, and refuses what it would have to cut", async () => {
    // correct_voice refreshes ~/.claude/CLAUDE.md; point home at a sandbox so
    // the suite never rewrites the developer's own.
    const home = mkdtempSync(join(tmpdir(), "aj-home-"));
    const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    const dir = mkdtempSync(join(tmpdir(), "aj-mcp-"));
    const config = ConfigSchema.parse({ memoryDir: dir, git: false, search: "fts" });
    await migrate(config);
    const paths = storePaths(dir);
    const indexer = Indexer.open(paths, config);
    const server = new McpServer({ name: "agent-julia", version: "test" });
    registerTools(server, { config, paths, indexer });
    const client = new Client({ name: "test-client", version: "test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanup = async () => {
      await client.close();
      indexer.close();
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };

    const saved = textOf(
      await client.callTool({ name: "correct_voice", arguments: { note: "No headers\nin short replies." } }),
    );
    expect(saved).toContain("Saved: No headers in short replies.");

    const tooLong = "Write plainly. ".repeat(100);
    const refused = textOf(await client.callTool({ name: "correct_voice", arguments: { note: tooLong } }));
    expect(refused).toMatch(/^Nothing saved/);
    expect(refused).toContain("Split it");
    expect(readFileSync(paths.voiceCorrections, "utf8")).not.toContain("Write plainly.");
  });
});
