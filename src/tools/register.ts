import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Runtime } from "../runtime.js";
import { archivePage, listPages, readPage, readPageRaw, relatedPages } from "../store/markdown.js";
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
      annotations: { readOnlyHint: true, openWorldHint: false },
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
      annotations: { readOnlyHint: true, openWorldHint: false },
      title: "List memory pages",
      description:
        "List pages in the knowledge base with title, status, and last-updated date, newest first. " +
        "Returns a bounded page of results — prefer `search` when you know what you are looking for.",
      inputSchema: {
        limit: z.number().int().positive().max(500).optional().describe("How many to return (default 50)"),
        since: z.string().optional().describe("Only pages updated on or after this ISO date, e.g. '2026-09-01'"),
      },
    },
    async ({ limit, since }) => {
      const all = await listPages(paths);
      const filtered = since ? all.filter((p) => (p.updated ?? "") >= since) : all;
      const sorted = [...filtered].sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
      const shown = sorted.slice(0, limit ?? 50);
      // Compact, not pretty-printed: 189 pages at two-space indent is roughly
      // 7,800 tokens, six times the persona budget, in a product whose whole
      // claim is keeping the context window clear.
      return text(
        JSON.stringify({ total: all.length, matched: filtered.length, shown: shown.length, pages: shown }),
      );
    },
  );

  server.registerTool(
    "read",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      title: "Read a memory page",
      description:
        "Read one page by id (e.g. 'elnino'), exactly as stored, front matter included. " +
        "To edit a page, read it, change what you mean to change, and write the whole thing back with ingest mode 'replace'.",
      inputSchema: { page: z.string().describe("Page id, e.g. 'elnino' or 'pages/elnino'") },
    },
    async ({ page }) => {
      const raw = await readPageRaw(paths, page);
      if (raw === null) return text(`No page found: ${page}`);
      return text(raw);
    },
  );

  server.registerTool(
    "search",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
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
      annotations: { readOnlyHint: true, openWorldHint: false },
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      title: "Ingest / update a memory page",
      description:
        "Write a page. Enforces the store schema: writes the page, refreshes index.md, appends log.md, updates the search index, and git-commits. " +
        "MODE MATTERS. 'append' adds your content under what the page already holds — this is what saving a new fact about an existing topic means. " +
        "'replace' (the default, for backwards compatibility) makes your content the ENTIRE page: everything already there is gone. " +
        "Use 'replace' only when you are rewriting a page whose current text you have just read. A replace that would destroy most of an existing page is refused; " +
        "the error tells you how to proceed deliberately. Content may include YAML frontmatter (title/status/tags); 'updated' is set automatically and existing frontmatter is preserved.",
      inputSchema: {
        page: z.string().describe("Page id, kebab-case, e.g. 'prive-game'"),
        content: z.string().describe("Markdown body (optionally with frontmatter)"),
        mode: z
          .enum(["append", "replace"])
          .optional()
          .describe("'append' to add to the page (use this for a new fact), 'replace' to overwrite it entirely. Default: replace"),
        confirm: z
          .boolean()
          .optional()
          .describe("Set true to carry out a replace that the destructive-write guard refused"),
        title: z.string().optional().describe("Page title if not in frontmatter"),
        status: z.string().optional().describe("Status header, e.g. 'active' (default)"),
      },
    },
    async ({ page, content, mode, confirm, title, status }) => {
      try {
        const res = await ingest(paths, indexer, page, content, {
          title,
          status,
          mode,
          confirm,
          git: config.git,
          autoPush: config.gitAutoPush,
        });
        return json({ ok: true, ...res });
      } catch (err) {
        // A refusal is an answer, not a crash: the model needs to read it and
        // choose append or confirm, rather than see a dead tool.
        return json({ ok: false, error: (err as Error).message });
      }
    },
  );

  server.registerTool(
    "correct_voice",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
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
      return text(
        `Archived: ${page} → ${moved.replace(paths.root + "/", "")} (removed from the index and catalog). ` +
          `Read it back with read("archive/${pageId(page)}").`,
      );
    },
  );

  server.registerTool(
    "maintenance",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
