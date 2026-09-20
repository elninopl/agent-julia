import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Runtime, buildRuntime } from "./runtime.js";
import { registerTools } from "./tools/register.js";
import { composeCore } from "./persona/compose.js";
import { serverInstructions } from "./persona/startup.js";
import { getMeta, setMeta } from "./index/db.js";
import { latestStoreMtime } from "./store/markdown.js";
import { runMaintenance } from "./maintenance/maintenance.js";
import { pullFromRemote } from "./store/git.js";
import { waitForIdle } from "./store/lock.js";
import { installSkills, skillsTargetDir } from "./skills/install.js";
import { refreshInjectedCore } from "./wizard/register.js";
import { refreshExports } from "./export/export.js";
import { log, warn } from "./util/log.js";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAINT_MTIME_KEY = "maint_mtime";
// How long a shutdown waits for an in-flight write before exiting anyway.
const DRAIN_MS = 5_000;
// How often to check that the client that spawned us is still alive.
const WATCHDOG_MS = 30_000;

// The package version, read from package.json (two levels up from dist/ and
// src/ alike). Best-effort — the server must boot even if the read fails.
async function packageVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(join(here, "..", "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Startup housekeeping: pull, maintenance, and refreshing what init/sync
// installed. Deliberately run AFTER the transport is connected. Every step here
// touches the network or the whole store, and any one of them stalling used to
// cost the session its memory tools before the client ever finished the
// handshake — invisibly, because a stdio server's diagnostics go nowhere the
// user looks. Tools answer while this runs; the index is already open.
// Was this machine ever asked to paste, or seen running, the old long block?
// Evidence only — the mirror file exists for everyone with the cowork surface,
// including people who never pasted at all, so it is not evidence and is not
// used as such.
async function detectLegacyPaste(): Promise<void> {
  try {
    const { readPasteMarker, writePasteMarker, legacyPasteMarkerPath } = await import(
      "./wizard/register.js"
    );
    const marker = await readPasteMarker();
    if (marker && marker.previousLayout !== undefined) return;
    if (marker && marker.layout >= 2) return;

    const { existsSync } = await import("node:fs");
    const askedUnderLayout1 = existsSync(legacyPasteMarkerPath());
    const { probeCoworkSession } = await import("./surfaces/cowork-probe.js");
    const probe = await probeCoworkSession();
    const seenLayout1 = probe.status === "found" && probe.layout === 1;
    if (!askedUnderLayout1 && !seenLayout1) return;

    const { pasteBody, pasteHash, configFingerprint, PASTE_LAYOUT } = await import("./persona/paste.js");
    const cfg = (await import("./config/config.js")).loadConfig;
    const config = await cfg();
    await writePasteMarker({
      layout: marker?.layout ?? 1,
      variant: "stable",
      stableHash: marker?.stableHash ?? pasteHash(await pasteBody(config)),
      configFingerprint: marker?.configFingerprint ?? configFingerprint(config),
      askedAt: marker?.askedAt ?? new Date().toISOString(),
      askedOn: marker?.askedOn ?? "unknown",
      previousLayout: 1,
    });
    log(`Claude Desktop still has the old long paste (layout 1); the current one is layout ${PASTE_LAYOUT}`);
  } catch {
    // evidence gathering must never take the server down
  }
}

async function runStartupTasks(rt: Runtime): Promise<void> {
  await detectLegacyPaste();
  // Two-machine sync: pull the store from its remote before maintenance reads
  // it, so a session on this machine starts from what the other machine pushed.
  // Best-effort — offline is a quiet skip, a conflict is aborted and warned.
  if (rt.config.git && rt.config.gitRemote) {
    const pulled = await pullFromRemote(rt.config.memoryDir);
    log(`git pull: ${pulled}`);
  }

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

  // Refresh what init/sync installed: the shipped skills, and the persona block
  // in files that already carry it. Installs register the server as floating
  // @latest, so boot-time refresh is what propagates updated skills, voice, and
  // corrections to existing users without a manual `sync`. Skills only ever
  // touch copies carrying the agent-julia ownership marker; the persona refresh
  // never creates a block, only updates existing ones. Non-fatal.
  try {
    // Under the store lock: every Claude session spawns its own server, and on a
    // busy machine a dozen of them boot at once and rewrite ~/.claude/CLAUDE.md
    // and ~/.claude/skills at the same moment.
    const { withStoreLock } = await import("./store/lock.js");
    const refreshed = await withStoreLock(rt.config.memoryDir, async () => ({
      steps: await installSkills(skillsTargetDir()),
      cores: await refreshInjectedCore(rt.config),
      exports: await refreshExports(rt.config),
    }));
    if (!refreshed) {
      log("refresh: another server was doing it — skipped");
      return;
    }
    const { steps, cores, exports } = refreshed;
    log(
      `refresh: ${steps.filter((s) => s.status === "done").length}/${steps.length} skill(s), ` +
        `${cores} persona block(s), ${exports} export(s)`,
    );
  } catch (err) {
    warn("startup refresh failed (continuing):", (err as Error).message);
  }
}

// Which client started this server, so doctor can say whether the voice ever
// reaches Claude Desktop — the surface that cannot be inspected any other way.
async function recordBoot(server: McpServer): Promise<void> {
  try {
    const { readSurfaces, writeSurfaces } = await import("./wizard/register.js");
    const client = server.server.getClientVersion()?.name ?? "unknown";
    const state = await readSurfaces();
    await writeSurfaces({ ...state, boots: { ...state.boots, [client]: { at: new Date().toISOString() } } });
  } catch {
    // bookkeeping must never take the server down
  }
}

// Exit when the process that spawned us does. Claude starts one server per
// session and does not always close the pipe or send a signal on the way out:
// on one machine this left 88 live servers, the oldest twelve days old, holding
// 954 MB and a WAL handle each, every one of them having rewritten the user's
// CLAUDE.md and skills directory at boot. A reparented process (ppid changed,
// usually to 1) is an orphan.
function startParentWatchdog(onOrphaned: () => void): void {
  const parent = process.ppid;
  const timer = setInterval(() => {
    if (process.ppid !== parent) {
      clearInterval(timer);
      onOrphaned();
    }
  }, WATCHDOG_MS);
  // Never hold the process open for the watchdog itself.
  timer.unref?.();
}

// Boot the MCP stdio server. Runs migrations, opens the index, registers tools,
// and exposes the budgeted persona core as a resource for clients that prefer
// resources over a tool call.
export async function startServer(): Promise<void> {
  const rt = await buildRuntime();
  // Assigned once the handler below exists; the transport can close before then.
  let shutdownRef: ((why: string) => void) | null = null;

  const server = new McpServer(
    { name: "agent-julia", version: await packageVersion() },
    {
      // The only channel into a Claude Desktop session that needs no human
      // action. It carries the stable layer — identity, language, the privacy
      // rail, and the order to fetch the rest — because the volatile half is
      // too large for it and would double up with Claude Code's block.
      instructions: serverInstructions(rt.config),
    },
  );

  registerTools(server, rt);

  server.registerResource(
    "persona-core",
    "agent-julia://core",
    {
      title: "Persona core",
      description:
        "The same persona the get_core tool returns. Note that Claude Desktop maps tools only, " +
        "so this resource is not a delivery channel for Cowork — it is here for other MCP clients " +
        "and for attaching the core by hand.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const core = await composeCore(rt.paths, rt.config);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: core.text }] };
    },
  );

  const transport = new StdioServerTransport();
  const priorOnClose = transport.onclose;
  transport.onclose = () => {
    priorOnClose?.();
    shutdownRef?.("transport closed");
  };
  await server.connect(transport);
  log(`agent-julia serving "${rt.config.name}" — memory: ${rt.config.memoryDir}`);

  startParentWatchdog(() => shutdown("the client that started this server is gone"));

  await recordBoot(server);
  await runStartupTasks(rt);

  let down = false;
  const shutdown = (why: string) => {
    if (down) return;
    down = true;
    log(`shutting down (${why})`);
    // Give an in-flight write its lock and its commit. process.exit() used to
    // fire immediately, so a shutdown landing mid-ingest could leave the page on
    // disk, the journal appended and nothing committed. The deadline keeps a
    // wedged operation from turning into a process that never exits.
    const deadline = setTimeout(() => process.exit(0), DRAIN_MS);
    deadline.unref?.();
    void (async () => {
      try {
        await waitForIdle(DRAIN_MS);
      } finally {
        clearTimeout(deadline);
        try {
          rt.indexer.close();
        } catch {
          // closing a db that is already gone is not worth a failed exit
        }
        process.exit(0);
      }
    })();
  };

  // Registered BEFORE connect: the SDK chains its own handler onto
  // transport.onclose inside connect(), and assigning afterwards discarded it.
  shutdownRef = shutdown;
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // Reap the server when its client goes away. Claude spawns one serve per
  // session and may close the stdio pipe without sending a signal; without this
  // the process (and its npm-exec wrapper) lingers for hours.
  process.stdin.on("end", () => shutdown("stdin ended"));
  process.stdin.on("close", () => shutdown("stdin closed"));
}
