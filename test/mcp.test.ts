import { mkdtempSync } from "node:fs";
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
      arguments: { page: "prive-game", content: "Quiz game for couples, marketed on Reddit." },
    });

    const hits = textOf(await client.callTool({ name: "search", arguments: { query: "couples reddit" } }));
    expect(hits).toContain("prive-game");

    const page = textOf(await client.callTool({ name: "read", arguments: { page: "prive-game" } }));
    expect(page).toContain("Quiz game for couples");

    const core = textOf(await client.callTool({ name: "get_core", arguments: {} }));
    expect(core).toContain("Julia");
  });
});
