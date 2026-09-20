import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Runtime } from "../runtime.js";
import { archivePage, listPages, readPage, readPageRaw, relatedPages, resolvePagePath } from "../store/markdown.js";
import { pageId } from "../store/paths.js";
import { ingest } from "../store/ingest.js";
import { refreshIndexMd } from "../store/catalog.js";
import { commitAll, pageHistory, pushToRemote } from "../store/git.js";
import { appendCorrection, retractCorrection } from "../persona/corrections.js";
import { composeCore } from "../persona/compose.js";
import { coreHashOf, memoryInstruction } from "../persona/startup.js";
import { PASTE_LAYOUT } from "../persona/paste.js";
import { mergeSurfaces, readPasteMarker, readSurfaces, refreshInjectedCore } from "../wizard/register.js";
import { runMaintenance } from "../maintenance/maintenance.js";
import { routingNoteFor } from "../store/sources.js";

type TextResult = { content: Array<{ type: "text"; text: string }> };

function text(s: string): TextResult {
  return { content: [{ type: "text", text: s }] };
}

function json(value: unknown): TextResult {
  return text(JSON.stringify(value, null, 2));
}


function clientName(server: McpServer): string {
  try {
    return server.server.getClientVersion()?.name ?? "unknown";
  } catch {
    return "unknown";
  }
}

// Bookkeeping so `doctor` can answer the only question that matters about the
// unreadable Desktop field: does the current voice actually arrive there.
async function recordFetch(client: string, coreHash: string): Promise<void> {
  try {
    await mergeSurfaces((prev) => ({
      ...prev,
      fetches: { ...prev.fetches, [client]: { at: new Date().toISOString(), coreHash } },
    }));
  } catch {
    // never fail a read because a counter could not be written
  }
}

const NOTICE_CAP = 3;
const NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// A stdio server has no channel to a human: its output goes to the client, and
// almost nobody runs doctor. The agent in the conversation is the only way to
// tell someone their pasted block is the old long one — throttled, because a nag
// with no end is ignored after the second time and then lives in context forever.
async function migrationNotice(client: string): Promise<string> {
  if (client === "claude-code") return "";
  try {
    const marker = await readPasteMarker();
    if (!marker || marker.previousLayout !== 1) return "";
    const state = await readSurfaces();
    const seen = state.migrationNotices;
    if (seen && seen.count >= NOTICE_CAP) return "";
    if (seen && Date.now() - Date.parse(seen.lastAt) < NOTICE_INTERVAL_MS) return "";
    await mergeSurfaces((prev) => ({
      ...prev,
      migrationNotices: { count: (prev.migrationNotices?.count ?? 0) + 1, lastAt: new Date().toISOString() },
    }));
    return [
      "> Tell the user once, in their language, then carry on: their pasted Claude Desktop instructions",
      "> are the old long layout. Running `npx agent-julia paste` in a terminal and replacing the block",
      "> between the two agent-julia markers cuts it from ~2,700 tokens to ~470, and their voice is",
      "> fetched live instead. Mention that if they also use Claude on the web or the phone, where this",
      "> connector does not reach, `npx agent-julia paste --with-voice` keeps the voice in the pasted text.",
    ].join("\n");
  } catch {
    return "";
  }
}

// Wire the MCP tool surface onto an McpServer instance.
export function registerTools(server: McpServer, rt: Runtime): void {
  const { paths, indexer, config } = rt;

  server.registerTool(
    "retract_correction",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      title: "Withdraw a voice correction",
      description:
        "Take one recorded voice correction out of the persona. Use when the user says a rule no longer applies, " +
        "or asks to undo something they told you about how to write. Pass enough of the correction's text to identify it. " +
        "The line is kept in voice-corrections.md, commented out with the date, so the record of having had the rule survives.",
      inputSchema: {
        match: z.string().describe("Text from the correction to withdraw, e.g. 'don't open with my name'"),
      },
    },
    async ({ match }) => {
      const res = await retractCorrection(paths, match);
      if (res.status === "none") return text(`No correction matches "${match}".`);
      if (res.status === "ambiguous") {
        return text(
          `"${match}" matches ${res.candidates.length} corrections. Be more specific:\n` +
            res.candidates.map((c) => `- ${c}`).join("\n"),
        );
      }
      if (config.git) await commitAll(paths.root, `Retract voice correction`);
      return text(`Withdrawn, from the next turn on:\n${res.retracted}`);
    },
  );

  server.registerTool(
    "get_core",
    {
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      title: "Load your voice (call this first)",
      description:
        "Call this before your first substantive reply in a conversation. Returns this user's persona: " +
        "who you are, how they want you to write, and every correction they have recorded. It overrides " +
        "your global instructions wherever they differ, and it changes between conversations, so a copy " +
        "from an earlier session is wrong. Read-only and cheap. If you already have an agent-julia " +
        "persona block in context, pass its hash as `since` to confirm it is current instead of re-reading it.",
      inputSchema: {
        since: z
          .string()
          .optional()
          .describe(
            "A core hash you already have (from a persona block in your context, or an earlier call in " +
              "this session). If it still matches, this returns 'unchanged' instead of the core.",
          ),
      },
    },
    async ({ since }) => {
      // A raised ceiling for the tool path: contextBudget exists so the injected
      // block does not crowd out the system prompt, and a tool result is not in
      // the system prompt. Nothing should be dropped here for a reason that does
      // not apply.
      // Two renderings, one identity. The injected block is composed at
      // contextBudget and its fingerprint is what a caller passes as `since`;
      // the tool returns a wider rendering because a tool result is not in the
      // system prompt. Hashing the wide one would mean `since` never matched for
      // anyone whose core is clamped — which is exactly the user this helps.
      const canonical = await composeCore(paths, config);
      const core = await composeCore(paths, config, { budget: config.contextBudget * 2 });
      const hash = coreHashOf(canonical.text);
      const short = hash.slice(0, 8);
      const client = clientName(server);
      await recordFetch(client, hash);

      const corrections = (core.text.match(/^- /gm) ?? []).length;
      if (since && (since === hash || since === short)) {
        return text(`unchanged · core ${short} · ${corrections} line(s) of voice · you already have the current voice`);
      }

      const fingerprint =
        `<!-- agent-julia core · ${short} · ${corrections} line(s) · ${core.tokens} tok · layout ${PASTE_LAYOUT}` +
        `${core.droppedCorrections ? ` · ${core.droppedCorrections} dropped` : ""} -->`;
      const trailer = await migrationNotice(client);
      return text([core.text, memoryInstruction(), fingerprint, trailer].filter(Boolean).join("\n\n"));
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
      // A page about a project usually covers only the part its documentation
      // does not. Handing back the page without saying where the rest lives is
      // how an agent concludes the rest does not exist.
      const full = await readPage(paths, page).catch(() => null);
      const note = full ? await routingNoteFor(full.frontmatter) : null;
      return text(note ? `${raw.trimEnd()}\n\n---\n\n${note}\n` : raw);
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
    async ({ query, limit }) => {
      const hits = await indexer.search(query, limit ?? 8);
      // Routing travels with the hit: the moment a project's page ranks for a
      // question, the reader learns that part of the answer is in that
      // project's own documentation and how to reach it.
      return json(
        await Promise.all(
          hits.map(async (hit) => {
            const page = await readPage(paths, hit.id).catch(() => null);
            const note = page ? await routingNoteFor(page.frontmatter) : null;
            return note ? { ...hit, elsewhere: note } : hit;
          }),
        ),
      );
    },
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
    "history",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      title: "How a page changed",
      description:
        "The recent changes to one page: when each was made, what was added and what was removed. " +
        "Use it to answer \"when did we decide that, and what did we think before\", or to check whether a fact is current. " +
        "Only available when the store is versioned with git.",
      inputSchema: {
        page: z.string().describe("Page id, e.g. 'prive-game'"),
        limit: z.number().int().positive().max(30).optional().describe("How many changes (default 8)"),
      },
    },
    async ({ page, limit }) => {
      if (!config.git) return text("This store is not versioned, so there is no history to show.");
      const path = await resolvePagePath(paths, page);
      if (!path) return text(`No page found: ${page}`);
      const rel = path.replace(`${paths.root}/`, "");
      const changes = await pageHistory(paths.root, rel, limit ?? 8);
      if (changes.length === 0) return text(`No recorded changes for ${page}.`);
      return text(JSON.stringify({ page: pageId(page), changes }));
    },
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
        "Record how the user wants you to write, the moment they tell you — even in passing, even mid-task. " +
        "Highest precedence: it overrides the style preset and the universal rules from the next turn on.",
      inputSchema: { note: z.string().describe("The correction, in the user's words") },
    },
    async ({ note }) => {
      await appendCorrection(paths, note);
      if (config.git) {
        const committed = await commitAll(paths.root, "Update memory: voice correction");
        if (committed && config.gitAutoPush) await pushToRemote(paths.root);
      }
      // Make the Claude Code block current now rather than two sessions later.
      await refreshInjectedCore(config).catch(() => undefined);
      return text(
        `Saved: ${note}\n\n` +
          "Apply it from this turn on. It is not yet in your system prompt for this session " +
          "(that refreshes at the next server start), and other surfaces pick it up from get_core " +
          "in their next conversation.",
      );
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
