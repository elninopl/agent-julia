import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildRuntime } from "./runtime.js";
import { registerTools } from "./tools/register.js";
import { composeCore } from "./persona/compose.js";
import { runMaintenance } from "./maintenance/maintenance.js";
import { log, warn } from "./util/log.js";

// Boot the MCP stdio server. Runs migrations, opens the index, registers tools,
// and exposes the budgeted persona core as a resource for clients that prefer
// resources over a tool call.
export async function startServer(): Promise<void> {
  const rt = await buildRuntime();

  // Automatic maintenance on launch ("on write + cron" — this is the cron-ish
  // half). Incremental and non-fatal: picks up hand-edited pages, flags stale
  // facts, refreshes the catalog, commits if anything changed. Never blocks serve.
  try {
    const report = await runMaintenance(rt.paths, rt.indexer, rt.config, "auto");
    log(
      `maintenance: +${report.indexAdded}/~${report.indexUpdated}/-${report.indexRemoved} indexed, ` +
        `${report.staleFlagged.length} stale, ${report.orphanLinks.length} orphan link(s)`,
    );
  } catch (err) {
    warn("startup maintenance failed (continuing):", (err as Error).message);
  }

  const server = new McpServer({
    name: "agent-julia",
    version: "0.1.0",
  });

  registerTools(server, rt);

  server.registerResource(
    "persona-core",
    "agent-julia://core",
    {
      title: "Persona core",
      description: "Budgeted persona core to inject into context (identity + voice + corrections).",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const core = await composeCore(rt.paths, rt.config);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: core.text }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`agent-julia serving "${rt.config.name}" — memory: ${rt.config.memoryDir}`);

  const shutdown = () => {
    rt.indexer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
