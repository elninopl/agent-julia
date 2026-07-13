import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Runtime } from "../runtime.js";
import { archivePage, listPages, readPage, relatedPages } from "../store/markdown.js";
import { pageId } from "../store/paths.js";
import { ingest } from "../store/ingest.js";
import { refreshIndexMd } from "../store/catalog.js";
import { commitAll, pushToRemote } from "../store/git.js";
import { appendCorrection } from "../persona/corrections.js";
import { composeCore } from "../persona/compose.js";
import { runMaintenance } from "../maintenance/maintenance.js";

type TextResult = { content: Array<{ type: "text"; text: string }> };

function text(s: string): TextResult {
  return { content: [{ type: "text", text: s }] };
}

function json(value: unknown): TextResult {
  return text(JSON.stringify(value, null, 2));
}

// Wire the v0.1 MCP tool surface onto an McpServer instance.
export function registerTools(server: McpServer, rt: Runtime): void {
  const { paths, indexer, config } = rt;

  server.registerTool(
    "get_core",
    {
      title: "Get persona core",
      description:
        "Return the budgeted persona core (identity + voice rules + corrections) to inject into context. Keep this small; the full knowledge base lives on disk.",
      inputSchema: {},
    },
    async () => {
      const core = await composeCore(paths, config);
      return text(core.text);
    },
  );

  server.registerTool(
    "list",
    {
      title: "List memory pages",
      description: "List all pages in the knowledge base with title, status, and last-updated date.",
      inputSchema: {},
    },
    async () => json(await listPages(paths)),
  );

  server.registerTool(
    "read",
    {
      title: "Read a memory page",
      description: "Read the full markdown of one page by id (e.g. 'elnino').",
      inputSchema: { page: z.string().describe("Page id, e.g. 'elnino' or 'pages/elnino'") },
    },
    async ({ page }) => {
      const found = await readPage(paths, page);
      if (!found) return text(`No page found: ${page}`);
      return text(`# ${found.frontmatter.title ?? found.id}\n\n${found.body}`);
    },
  );

  server.registerTool(
    "search",
    {
      title: "Search memory",
      description:
        "Search the knowledge base (full-text + semantic, per configured mode). Returns ranked page ids with snippets.",
      inputSchema: {
        query: z.string().describe("Natural-language or keyword query"),
        limit: z.number().int().positive().max(50).optional().describe("Max results (default 8)"),
      },
    },
    async ({ query, limit }) => json(await indexer.search(query, limit ?? 8)),
  );

  server.registerTool(
    "related",
    {
      title: "Related pages",
      description:
        "Pages connected to one page through [[wiki-links]]: what it links to, and what links back to it. Use to walk the knowledge graph around a topic.",
      inputSchema: { page: z.string().describe("Page id, e.g. 'prive-game'") },
    },
    async ({ page }) => json(await relatedPages(paths, page)),
  );

  server.registerTool(
    "ingest",
    {
      title: "Ingest / update a memory page",
      description:
        "Create or update a page. Enforces the store schema: writes the page, refreshes index.md, appends log.md, updates the search index, and git-commits. Content may include YAML frontmatter (title/status/tags); 'updated' is set automatically.",
      inputSchema: {
        page: z.string().describe("Page id, kebab-case, e.g. 'prive-game'"),
        content: z.string().describe("Markdown body (optionally with frontmatter)"),
        title: z.string().optional().describe("Page title if not in frontmatter"),
        status: z.string().optional().describe("Status header, e.g. 'active' (default)"),
      },
    },
    async ({ page, content, title, status }) => {
      const res = await ingest(paths, indexer, page, content, {
        title,
        status,
        git: config.git,
        autoPush: config.gitAutoPush,
      });
      return json({ ok: true, ...res });
    },
  );

  server.registerTool(
    "correct_voice",
    {
      title: "Record a voice correction",
      description:
        "Append a user voice correction (L3, highest precedence) — e.g. \"don't praise me\", \"that phrasing is weird\", \"don't use word X\". Surfaced into the injected core.",
      inputSchema: { note: z.string().describe("The correction, in the user's words") },
    },
    async ({ note }) => {
      await appendCorrection(paths, note);
      if (config.git) {
        const committed = await commitAll(paths.root, "Update memory: voice correction");
        if (committed && config.gitAutoPush) await pushToRemote(paths.root);
      }
      return text(`Recorded voice correction: ${note}`);
    },
  );

  server.registerTool(
    "archive",
    {
      title: "Archive a memory page",
      description:
        "Retire a page from the active knowledge base into archive/ (kept on disk and in git history, removed from the index and catalog). Use for pages the user confirmed are obsolete — e.g. from the weekly digest. Ask before archiving; never bulk-archive.",
      inputSchema: { page: z.string().describe("Page id, e.g. 'old-project'") },
    },
    async ({ page }) => {
      const moved = await archivePage(paths, page);
      if (!moved) return text(`No page found: ${page}`);
      indexer.removePage(pageId(page));
      await refreshIndexMd(paths);
      if (config.git) {
        const committed = await commitAll(paths.root, `Archive memory page: ${page}`);
        if (committed && config.gitAutoPush) await pushToRemote(paths.root);
      }
      return text(`Archived: ${page} (moved to archive/, removed from index and catalog).`);
    },
  );

  server.registerTool(
    "maintenance",
    {
      title: "Run maintenance",
      description:
        "Run maintenance. 'auto': rebuild the search index, flag orphan links and stale facts, refresh index.md, recompact the core, commit. 'interactive' — the weekly digest: additionally returns owner-judgment proposals (near-duplicate pages to merge, stale pages to confirm or retire, orphan links, unlinked pages, oversized pages to split). Walk the user through the proposals ONE AT A TIME, never in bulk; apply only what they approve — merge with 'ingest', retire with 'archive', skip freely. Nothing in the digest changes anything by itself.",
      inputSchema: {
        mode: z.enum(["auto", "interactive"]).optional().describe("default: auto"),
      },
    },
    async ({ mode }) => json(await runMaintenance(paths, indexer, config, mode ?? "auto")),
  );
}
