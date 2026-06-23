import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildRuntime } from "./runtime.js";
import { registerTools } from "./tools/register.js";
import { composeCore } from "./persona/compose.js";
import { getMeta, setMeta } from "./index/db.js";
import { latestStoreMtime } from "./store/markdown.js";
import { runMaintenance } from "./maintenance/maintenance.js";
import { log, warn } from "./util/log.js";

const MAINT_MTIME_KEY = "maint_mtime";

// Boot the MCP stdio server. Runs migrations, opens the index, registers tools,
// and exposes the budgeted persona core as a resource for clients that prefer
// resources over a tool call.
export async function startServer(): Promise<void> {
  const rt = await buildRuntime();

  // Automatic maintenance on launch ("on write + cron" — this is the cron-ish
  // half). Skip it when nothing on disk changed since the last run: every Claude
  // session spawns its own serve, so running full maintenance (read all pages,
  // refresh the catalog, git add/commit) on every cold start is pure repeated
  // cost. The mtime check is a readdir + stat, no content reads. Non-fatal.
  try {
    const latest = await latestStoreMtime(rt.paths);
    const stored = Number(getMeta(rt.indexer.db, MAINT_MTIME_KEY) ?? 0);
    if (latest > stored) {
      const report = await runMaintenance(rt.paths, rt.indexer, rt.config, "auto");
      setMeta(rt.indexer.db, MAINT_MTIME_KEY, String(latest));
      log(
        `maintenance: +${report.indexAdded}/~${report.indexUpdated}/-${report.indexRemoved} indexed, ` +
          `${report.staleFlagged.length} stale, ${report.orphanLinks.length} orphan link(s)`,
      );
    } else {
      log("maintenance: store unchanged since last run — skipped");
    }
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

  let down = false;
  const shutdown = () => {
    if (down) return;
    down = true;
    rt.indexer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Reap the server when its client goes away. Claude spawns one serve per
  // session and may close the stdio pipe without sending a signal; without this
  // the process (and its npm-exec wrapper) lingers for hours. Exit when the
  // transport closes or stdin ends.
  transport.onclose = shutdown;
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
}
