#!/usr/bin/env node
import { startServer } from "./server.js";
import { runWizard } from "./wizard/wizard.js";
import { buildInstructions, install, uninstall } from "./wizard/register.js";
import { configExists, loadConfig, saveConfig } from "./config/config.js";
import { migrate } from "./migrations/runner.js";
import { ensureGitRepo, getRemoteUrl, pushToRemote, setRemoteUrl, verifyRemote } from "./store/git.js";
import { dirname } from "node:path";
import { logError } from "./util/log.js";
import type { Config } from "./config/schema.js";
import type { AdoptionReport } from "./surfaces/code-memory.js";
import { ABSORB_BATCH_LIMIT } from "./surfaces/code-memory.js";

const HELP = `agent-julia — one brain for your AI

Usage:
  agent-julia serve      Start the MCP stdio server (default; used by Claude clients)
  agent-julia serve --http [--host h] [--port n]  Run as a long-lived HTTP server for many clients (see "Run as a server")
  agent-julia serve --remote [url]  Relay to an agent-julia server instead of a local store (the default when the config has "remote")
  agent-julia server token add <name> [--stores a,b] | list | revoke <name>  Manage the server's bearer tokens
  agent-julia server set-owner  Set the password that approves OAuth connections (claude.ai)
  agent-julia server oauth list | revoke <client-id|all>  See or cut off the apps connected over OAuth
  agent-julia hooks install | uninstall | status  Claude Code hooks that remind the agent to save, and save what a session left out
  agent-julia init       Run the interactive setup wizard
  agent-julia sync       Re-apply MCP registration + persona core + shipped skills (--print shows the steps; --absorb-all also brings in a large Claude Code memory)
  agent-julia uninstall  Remove the managed persona blocks, MCP registration, and shipped skills
  agent-julia remote [url]  Show or set the git remote backing up your memory
  agent-julia push       Push the memory store to its remote now
  agent-julia pull       Pull the memory store from its remote now (two-machine sync)
  agent-julia maintenance  Run store maintenance now (reindex, flag stale/orphans, refresh catalog, commit)
  agent-julia doctor [--fix]  Check the installation (add --fix to repair what can be repaired safely)
  agent-julia search <query>   Search your memory from the terminal
  agent-julia read <page>      Print one memory page
  agent-julia export [target]  Export the persona to another tool's instruction file (codex, gemini, or a path); no target prints it
  agent-julia paste [--with-voice]  Print (and copy) the text to paste into Claude Desktop's "Instructions for Claude"
  agent-julia undo [sha] List the last memory commits, or undo one by id
  agent-julia reindex    Rebuild the search index from your markdown (it is disposable)
  agent-julia unarchive <page>  Bring a retired page back into the active store
  agent-julia relocate <path>   Move the memory store somewhere else and point the config at it
  agent-julia migrate    Run pending data migrations and exit
  agent-julia --help     Show this help
`;

// Fail fast on an unsupported Node before any command writes config or touches
// the store. node:sqlite (the index engine) is built in from Node 24.
function assertNodeVersion(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 24) {
    console.error(
      `agent-julia needs Node.js 24+ (it uses the built-in node:sqlite). Current: ${process.version}.\n` +
        "Upgrade Node (e.g. via nvm: `nvm install 24 && nvm use 24`), then re-run.",
    );
    process.exit(1);
  }
}

// Commands that work on the local store. A machine that connects to a server
// has none, and running them would quietly create an empty one.
const LOCAL_STORE_COMMANDS = new Set([
  "remote", "pull", "push", "search", "read", "export", "maintenance", "undo",
  "reindex", "unarchive", "relocate", "migrate",
]);

async function main(): Promise<void> {
  assertNodeVersion();
  const cmd = process.argv[2] ?? "serve";

  const withVoicePaste = cmd === "paste" && process.argv.includes("--with-voice");
  if ((LOCAL_STORE_COMMANDS.has(cmd) || withVoicePaste) && configExists()) {
    const cfg = await loadConfig();
    if (cfg.remote) {
      console.error(
        `This machine connects to the agent-julia server at ${cfg.remote.url}, so it has no memory store of its own. ` +
          `Run \`agent-julia ${cmd}\` on the server.`,
      );
      process.exit(1);
    }
  }

  switch (cmd) {
    case "serve": {
      if (process.argv.includes("--http")) {
        const flag = (name: string): string | undefined => {
          const i = process.argv.indexOf(name);
          return i > 0 ? process.argv[i + 1] : undefined;
        };
        const port = flag("--port");
        const host = flag("--host");
        if (port !== undefined && !/^\d+$/.test(port)) throw new Error(`--port needs a number, got "${port}"`);
        const { startHttpServer } = await import("./http/serve-http.js");
        await startHttpServer({
          ...(port !== undefined ? { port: Number(port) } : {}),
          ...(host !== undefined ? { host } : {}),
        });
        break;
      }
      const i = process.argv.indexOf("--remote");
      const remoteUrl = i > 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1] : undefined;
      const cfg = configExists() ? await loadConfig() : null;
      if (i > 0 || cfg?.remote) {
        if (!cfg) throw new Error("serve --remote needs a config for the persona's name and surfaces; run agent-julia init first");
        const { startRemoteProxy } = await import("./remote/remote.js");
        await startRemoteProxy(cfg, remoteUrl);
        break;
      }
      await startServer();
      break;
    }
    case "server": {
      const [sub, verb, arg] = process.argv.slice(3);
      if (sub === "set-owner") {
        const { readPassword, setOwnerPassword, ownerFile, ownerIsSet } = await import("./http/owner.js");
        const replacing = ownerIsSet();
        const first = await readPassword("Owner password (12+ characters): ");
        if (process.stdin.isTTY && (await readPassword("Again: ")) !== first) throw new Error("the passwords differ");
        await setOwnerPassword(first);
        console.log(`Owner password ${replacing ? "changed" : "set"} (kept hashed in ${ownerFile()}).`);
        if (replacing) console.log("Apps already connected stay connected. To cut them off: agent-julia server oauth revoke all");
        break;
      }
      if (sub === "oauth" && (verb === "list" || verb === "revoke")) {
        const { listOAuthClients, revokeOAuthClients, oauthFile } = await import("./http/oauth.js");
        if (verb === "list") {
          const clients = listOAuthClients();
          if (clients.length === 0) console.log(`No OAuth clients (${oauthFile()}).`);
          for (const c of clients) {
            console.log(
              `${c.id}  ${c.name}  registered ${c.registeredAt.slice(0, 10)}  ` +
                (c.lastUsedAt ? `last used ${c.lastUsedAt.slice(0, 10)}, ${c.grants} active grant(s)` : "never used"),
            );
          }
          break;
        }
        if (!arg) throw new Error("agent-julia server oauth revoke needs a client id (see `server oauth list`) or all");
        const n = await revokeOAuthClients(arg);
        console.log(n > 0 ? `Revoked ${n} client(s); they have to be approved again.` : `No client matches "${arg}".`);
        break;
      }
      if (sub !== "token" || !["add", "list", "revoke"].includes(verb ?? "")) {
        console.log(
          "Usage:\n  agent-julia server token add <name> [--stores primary,team] | list | revoke <name>\n" +
            "  agent-julia server set-owner\n  agent-julia server oauth list | revoke <client-id|all>",
        );
        break;
      }
      const { addToken, readTokens, revokeToken, tokensFile, PRIMARY_SCOPE } = await import("./http/tokens.js");
      if (verb === "list") {
        const tokens = await readTokens();
        if (tokens.length === 0) console.log(`No tokens (${tokensFile()}).`);
        for (const t of tokens) {
          console.log(`${t.name}  ${t.stores ? `stores: ${t.stores.join(", ")}` : "all stores"}  created ${t.createdAt.slice(0, 10)}`);
        }
        break;
      }
      if (!arg) throw new Error(`agent-julia server token ${verb} needs a name`);
      if (verb === "revoke") {
        console.log((await revokeToken(arg)) ? `Revoked "${arg}".` : `No token named "${arg}".`);
        break;
      }
      const i = process.argv.indexOf("--stores");
      const stores = i > 0 ? (process.argv[i + 1] ?? "").split(",").map((x) => x.trim()).filter(Boolean) : undefined;
      if (stores) {
        const cfg = await loadConfig();
        const known = new Set([PRIMARY_SCOPE, ...(cfg.stores ?? []).map((x) => x.name)]);
        const unknown = stores.filter((x) => !known.has(x));
        if (unknown.length > 0) {
          throw new Error(`unknown store(s): ${unknown.join(", ")}. Known: ${[...known].join(", ")}`);
        }
      }
      const { token } = await addToken(arg, stores);
      console.log(`Token "${arg}"${stores ? ` for ${stores.join(", ")}` : ""}. Shown once, store it now:\n\n${token}\n`);
      console.log(`Clients send it as: Authorization: Bearer <token>. Kept hashed in ${tokensFile()}.`);
      break;
    }
    case "hooks": {
      const verb = process.argv[3];
      const cfg = await loadConfig();
      const { installHooks, uninstallHooks, hookStatus } = await import("./hooks/hooks.js");
      if (verb === "install") {
        const res = await installHooks(cfg);
        console.log(`Hooks ${res.settingsChanged ? "written to" : "already in"} ${res.settingsFile}: ${res.events.join(", ")}.`);
        console.log("Every prompt: a reminder to call correct_voice when you correct the voice, and to ingest every " +
          `${res.config.capture?.nudgeEveryTurns ?? 10} turns.`);
        if (res.events.includes("PreCompact")) {
          console.log("Before a compaction and at the end of a session, a background `claude -p` reads what was said and saves " +
            "what the session did not. It runs on your Claude plan; set capture.extractOnCompact to false to turn it off.");
        }
        console.log("Restart Claude Code sessions to pick them up.");
      } else if (verb === "uninstall") {
        const res = await uninstallHooks(cfg);
        console.log(res.settingsChanged ? `Removed agent-julia hooks from ${res.settingsFile}.` : `No agent-julia hooks in ${res.settingsFile}.`);
      } else if (verb === "status") {
        const st = await hookStatus(cfg);
        console.log(`capture.hooks: ${st.enabled ? "on" : "off"}`);
        console.log(`settings: ${st.settingsFile} — ${st.events.length ? st.events.join(", ") : "no agent-julia hooks"}`);
        console.log(`script: ${st.script}${st.claude ? ` · claude: ${st.claude}` : ""}`);
      } else {
        console.log("Usage: agent-julia hooks install | uninstall | status");
      }
      break;
    }
    case "init":
    case "wizard":
      await runWizard();
      break;
    case "sync": {
      const cfg = await loadConfig();
      if (cfg.remote && !process.argv.includes("--print")) {
        const { remoteInstallInputs } = await import("./remote/remote.js");
        const { config: withId, core } = await remoteInstallInputs(cfg);
        const steps = await install(withId, { core });
        for (const s of steps) console.log(`[${s.status}] ${s.surface} — ${s.action}: ${s.detail}`);
        break;
      }
      if (process.argv.includes("--print")) {
        console.log(await buildInstructions(cfg));
      } else {
        const steps = await install(cfg);
        for (const s of steps) console.log(`[${s.status}] ${s.surface} — ${s.action}: ${s.detail}`);
        const code = await adoptCodeMemoryNow(cfg, process.argv.includes("--absorb-all"));
        console.log(
          `[${code.pointers + code.absorbed > 0 ? "done" : "skipped"}] code — Claude Code memory: ` +
            `${code.pointers} pointer(s) written across ${code.projects} director(ies), ` +
            `${code.absorbed} fact(s) absorbed, ${code.pending} left in place`,
        );
        if (code.overflow > 0) {
          console.log(
            `  ${code.overflow} director(ies) keep more than ${ABSORB_BATCH_LIMIT} facts of their own and were ` +
              "left alone. `agent-julia sync --absorb-all` brings those in too.",
          );
        }
      }
      break;
    }
    case "uninstall": {
      const steps = await uninstall();
      for (const s of steps) console.log(`[${s.status}] ${s.action}: ${s.detail}`);
      console.log("\nManaged blocks removed. Your *.agent-julia-bak backups and memory repo are untouched.");
      break;
    }
    case "remote": {
      const cfg = await loadConfig();
      const url = process.argv[3];
      if (!url) {
        const current = cfg.git ? await getRemoteUrl(cfg.memoryDir) : null;
        console.log(current ? `Remote: ${current}` : "No remote set. Pass a URL: agent-julia remote <url>");
        break;
      }
      if (!cfg.git) {
        console.log("Git is off for this store. Re-run `agent-julia init` and enable git to use a remote.");
        break;
      }
      await ensureGitRepo(cfg.memoryDir);
      await setRemoteUrl(cfg.memoryDir, url);
      await saveConfig({ ...cfg, gitRemote: url });
      const check = await verifyRemote(cfg.memoryDir);
      if (!check.ok) {
        console.log(`Remote set to ${url}, but it's NOT reachable yet (${check.error}).`);
        console.log("Create the repo / fix credentials, then run `agent-julia push`.");
        break;
      }
      const pushed = await pushToRemote(cfg.memoryDir);
      console.log(`Remote set to ${url} and reachable. ${pushed ? "Pushed." : "Nothing to push yet."}`);
      break;
    }
    case "pull": {
      const cfg = await loadConfig();
      if (!cfg.git || !cfg.gitRemote) {
        console.log("Nothing to pull (git off or no remote). Set one: agent-julia remote <url>");
        break;
      }
      const { pullFromRemote } = await import("./store/git.js");
      console.log(`Pull: ${await pullFromRemote(cfg.memoryDir)}`);
      break;
    }
    case "push": {
      const cfg = await loadConfig();
      const ok = cfg.git ? await pushToRemote(cfg.memoryDir) : false;
      console.log(ok ? "Pushed to remote." : "Nothing pushed (no remote, git off, or push failed).");
      break;
    }
    case "search": {
      const q = process.argv.slice(3).join(" ").trim();
      if (!q) {
        console.log("Usage: agent-julia search <query>");
        break;
      }
      const cfg = await loadConfig();
      const { primaryPaths } = await import("./store/paths.js");
      const { Indexer } = await import("./index/indexer.js");
      const idx = Indexer.open(primaryPaths(cfg), cfg);
      try {
        await idx.sync();
        const hits = await idx.search(q, 10);
        if (hits.length === 0) {
          console.log("No hits.");
        } else {
          for (const h of hits) {
            console.log(`${h.id}  —  ${h.title}${h.snippet ? `\n    ${h.snippet}` : ""}`);
          }
        }
      } finally {
        idx.close();
      }
      break;
    }
    case "read": {
      const page = process.argv[3];
      if (!page) {
        console.log("Usage: agent-julia read <page>");
        break;
      }
      const cfg = await loadConfig();
      const { primaryPaths } = await import("./store/paths.js");
      const { readPage } = await import("./store/markdown.js");
      const found = await readPage(primaryPaths(cfg), page);
      console.log(found ? `# ${found.frontmatter.title ?? found.id}\n\n${found.body}` : `No page found: ${page}`);
      break;
    }
    case "export": {
      const cfg = await loadConfig();
      const { exportPersona, exportText, removeExport, knownAliases } = await import("./export/export.js");
      const args = process.argv.slice(3);
      if (args[0] === "--list") {
        console.log(cfg.exports.length ? cfg.exports.join("\n") : "No exports recorded.");
        break;
      }
      if (args[0] === "--remove") {
        if (!args[1]) {
          console.log("Usage: agent-julia export --remove <target>");
          break;
        }
        const { path, removed } = await removeExport(cfg, args[1]);
        await saveConfig({ ...cfg, exports: cfg.exports.filter((e) => e !== path) });
        console.log(removed ? `Removed the persona block from ${path}.` : `No persona block in ${path}.`);
        break;
      }
      if (!args[0]) {
        console.log(await exportText(cfg));
        break;
      }
      const path = await exportPersona(cfg, args[0]);
      if (!cfg.exports.includes(path)) {
        await saveConfig({ ...cfg, exports: [...cfg.exports, path] });
      }
      console.log(`Persona exported to ${path} — the server keeps it refreshed from now on.`);
      console.log(`Known named targets: ${knownAliases().join(", ")} (or any file path).`);
      break;
    }
    case "maintenance": {
      const cfg = await loadConfig();
      const { primaryPaths } = await import("./store/paths.js");
      const { Indexer } = await import("./index/indexer.js");
      const { runMaintenance } = await import("./maintenance/maintenance.js");
      const idx = Indexer.open(primaryPaths(cfg), cfg);
      try {
        const r = await runMaintenance(primaryPaths(cfg), idx, cfg, "auto");
        console.log(
          `Maintenance done: +${r.indexAdded}/~${r.indexUpdated}/-${r.indexRemoved} indexed, ` +
            `${r.staleFlagged.length} stale-flagged, ${r.orphanLinks.length} orphan link(s), ` +
            `core ${r.coreTokens}/${r.coreBudget} tokens${r.committed ? ", committed" : ""}${r.pushed ? ", pushed" : ""}.`,
        );
        if (r.coreTruncated || r.coreDroppedCorrections > 0) {
          const parts = [
            r.coreTruncated ? "the style voice was cut off" : null,
            r.coreDroppedCorrections > 0 ? `${r.coreDroppedCorrections} correction(s) left out` : null,
          ].filter(Boolean);
          console.log(
            `Warning: the persona core does not fit contextBudget ${r.coreBudget} — ${parts.join(" and ")}. ` +
              `Raise contextBudget in the config, or shorten persona.md / voice-corrections.md.`,
          );
        }
        const { extraStores } = await import("./config/schema.js");
        if (extraStores(cfg).length > 0) {
          const { mountExtraStores } = await import("./store/stores.js");
          const { gitAvailable } = await import("./store/git.js");
          const stores = await mountExtraStores(cfg, { paths: primaryPaths(cfg), indexer: idx }, await gitAvailable());
          for (const s of stores) {
            try {
              const sr = await runMaintenance(s.paths, s.indexer, s.config, "auto");
              console.log(
                `Store ${s.name}: +${sr.indexAdded}/~${sr.indexUpdated}/-${sr.indexRemoved} indexed, ` +
                  `${sr.orphanLinks.length} orphan link(s)${sr.committed ? ", committed" : ""}${sr.pushed ? ", pushed" : ""}.`,
              );
            } catch (err) {
              console.log(`Store ${s.name}: maintenance failed (${(err as Error).message}).`);
            } finally {
              s.indexer.close();
            }
          }
        }
        console.log("For the interactive digest (merge/retire proposals), ask your agent to run the weekly digest.");
      } finally {
        idx.close();
      }
      break;
    }
    case "undo": {
      const cfg = await loadConfig();
      if (!cfg.git) {
        console.log("Git is off for this store, so there is no history to undo from.");
        break;
      }
      const { listStoreCommits, revertCommit } = await import("./store/git.js");
      const target = process.argv[3];
      if (!target) {
        const commits = await listStoreCommits(cfg.memoryDir, 10);
        if (commits.length === 0) {
          console.log("No commits in the store yet.");
          break;
        }
        console.log("Recent changes to your memory (newest first):\n");
        for (const c of commits) {
          const pages = c.files.filter((f) => f.startsWith("pages/")).map((f) => f.replace(/^pages\/|\.md$/g, ""));
          console.log(`  ${c.sha.slice(0, 8)}  ${c.date}  ${c.subject}`);
          if (pages.length) console.log(`            pages: ${pages.join(", ")}`);
        }
        console.log("\nUndo one with:  agent-julia undo <id>");
        break;
      }
      const { ok, error } = await revertCommit(cfg.memoryDir, target);
      if (!ok) {
        console.log(`Could not undo ${target}: ${error}`);
        process.exitCode = 1;
        break;
      }
      const { primaryPaths } = await import("./store/paths.js");
      const { Indexer } = await import("./index/indexer.js");
      const idx = Indexer.open(primaryPaths(cfg), cfg);
      try {
        const synced = await idx.sync();
        console.log(
          `Undone ${target} as a new commit. Index: +${synced.added}/~${synced.updated}/-${synced.removed}.`,
        );
        if (cfg.gitRemote) console.log("Run `agent-julia push` to send the undo to your remote.");
      } finally {
        idx.close();
      }
      break;
    }
    case "reindex": {
      const cfg = await loadConfig();
      const { primaryPaths } = await import("./store/paths.js");
      const { Indexer } = await import("./index/indexer.js");
      const idx = Indexer.open(primaryPaths(cfg), cfg);
      try {
        const n = await idx.rebuild();
        console.log(`Rebuilt the index from ${n} page(s) of markdown.`);
      } finally {
        idx.close();
      }
      break;
    }
    case "unarchive": {
      const page = process.argv[3];
      const cfg = await loadConfig();
      const { primaryPaths } = await import("./store/paths.js");
      const { listArchivedIds, unarchivePage } = await import("./store/markdown.js");
      const paths = primaryPaths(cfg);
      if (!page) {
        const ids = await listArchivedIds(paths);
        console.log(ids.length ? `Archived pages:\n  ${ids.join("\n  ")}` : "Nothing is archived.");
        console.log("\nBring one back with:  agent-julia unarchive <page>");
        break;
      }
      const restored = await unarchivePage(paths, page);
      if (!restored) {
        console.log(`No archived page called ${page}.`);
        process.exitCode = 1;
        break;
      }
      const { Indexer } = await import("./index/indexer.js");
      const { refreshIndexMd } = await import("./store/catalog.js");
      const idx = Indexer.open(paths, cfg);
      try {
        await idx.sync();
        await refreshIndexMd(paths);
      } finally {
        idx.close();
      }
      if (cfg.git) {
        const { commitAll } = await import("./store/git.js");
        await commitAll(cfg.memoryDir, `Unarchive memory page: ${page}`);
      }
      console.log(`Restored ${page} to ${restored}.`);
      break;
    }
    case "relocate": {
      const target = process.argv[3];
      const cfg = await loadConfig();
      if (!target) {
        console.log(`Memory store: ${cfg.memoryDir}\nMove it with:  agent-julia relocate <path>`);
        break;
      }
      const { expandPath } = await import("./util/paths.js");
      const { resolve } = await import("node:path");
      const { existsSync } = await import("node:fs");
      const { rename, mkdir } = await import("node:fs/promises");
      const to = resolve(expandPath(target));
      if (existsSync(to)) {
        console.log(`${to} already exists. Point the config at it by hand if that is the store you want.`);
        process.exitCode = 1;
        break;
      }
      if (existsSync(cfg.memoryDir)) {
        await mkdir(dirname(to), { recursive: true });
        await rename(cfg.memoryDir, to);
        console.log(`Moved ${cfg.memoryDir} -> ${to}`);
      } else {
        console.log(`${cfg.memoryDir} does not exist; pointing the config at ${to} without moving anything.`);
      }
      await saveConfig({ ...cfg, memoryDir: to });
      console.log("Config updated (previous versions kept as .1.bak). Restart your Claude apps.");
      break;
    }
    // Hidden: used by the wizard to pick a registration that can actually load
    // the local embedding model. Exits 0 when it can, 1 when it cannot.
    case "probe-embeddings": {
      const { checkLocalEmbeddingsAvailable } = await import("./index/embeddings.js");
      process.exit((await checkLocalEmbeddingsAvailable()) ? 0 : 1);
      break;
    }
    case "paste": {
      const cfg = await loadConfig();
      const withVoice = process.argv.includes("--with-voice");
      const { pasteBody, pasteWithVoice, pasteHash, configFingerprint, PASTE_LAYOUT } = await import(
        "./persona/paste.js"
      );
      const { primaryPaths } = await import("./store/paths.js");
      const { managedBlock } = await import("./managed/block.js");
      const { STARTUP_BLOCK_ID } = await import("./persona/startup.js");
      const { writePasteMarker } = await import("./wizard/register.js");
      const { copyToClipboard } = await import("./util/clipboard.js");
      const { hostname } = await import("node:os");

      const body = withVoice ? await pasteWithVoice(primaryPaths(cfg), cfg) : await pasteBody(cfg);
      const block = managedBlock(STARTUP_BLOCK_ID, body);
      const copied = await copyToClipboard(block);

      console.log(block);
      console.log("");
      console.log(
        copied
          ? "Copied to your clipboard. In Claude Desktop: Settings → Instructions for Claude →"
          : "Copy everything between the two agent-julia markers above. In Claude Desktop: Settings → Instructions for Claude →",
      );
      console.log("replace any earlier agent-julia block with it, save, and restart the app.");
      if (withVoice) {
        console.log("");
        console.log(
          "This is the long variant: it carries your voice and corrections as a frozen copy, for surfaces",
        );
        console.log("with no MCP connector. It goes stale as you record corrections. That is the trade.");
      } else {
        console.log("");
        console.log(
          "Short on purpose: your voice and corrections are fetched live, so this text does not go stale.",
        );
      }
      await writePasteMarker({
        layout: PASTE_LAYOUT,
        variant: withVoice ? "with-voice" : "stable",
        stableHash: pasteHash(body),
        configFingerprint: configFingerprint(cfg),
        askedAt: new Date().toISOString(),
        askedOn: hostname(),
        previousLayout: undefined,
      });
      break;
    }
    case "doctor": {
      const cfg = await loadConfig();
      if (cfg.remote) {
        const { runRemoteDoctor, formatChecks } = await import("./doctor/doctor.js");
        let checks = await runRemoteDoctor(cfg);
        console.log(formatChecks(checks));
        if (process.argv.includes("--fix") && checks.some((c) => c.name.startsWith("persona") || c.name.startsWith("mcp"))) {
          console.log("\nApplying the repairs that are safe to make automatically:");
          const { remoteInstallInputs } = await import("./remote/remote.js");
          const { config: withId, core } = await remoteInstallInputs(cfg);
          for (const s of await install(withId, { core })) console.log(`  [${s.status}] ${s.surface} — ${s.action}`);
          checks = await runRemoteDoctor(cfg);
          console.log("\nAfter:");
          console.log(formatChecks(checks));
        }
        if (checks.some((c) => c.status === "fail")) process.exit(1);
        break;
      }
      const { runDoctor, formatChecks } = await import("./doctor/doctor.js");
      let checks = await runDoctor(cfg);
      console.log(formatChecks(checks));
      if (process.argv.includes("--fix")) {
        console.log("\nApplying the repairs that are safe to make automatically:");
        const { primaryPaths } = await import("./store/paths.js");
        const { Indexer } = await import("./index/indexer.js");
        const paths = primaryPaths(cfg);
        if (checks.some((c) => c.name === "index" && c.status !== "ok")) {
          const { rmSync } = await import("node:fs");
          rmSync(paths.dbPath, { force: true });
          const idx = Indexer.open(paths, cfg);
          try {
            console.log(`  index: rebuilt from ${await idx.rebuild()} page(s)`);
          } finally {
            idx.close();
          }
        }
        const { refreshInjectedCore } = await import("./wizard/register.js");
        console.log(`  persona: refreshed ${await refreshInjectedCore(cfg)} block(s)`);
        const { installSkills, skillsTargetDir } = await import("./skills/install.js");
        const steps = await installSkills(skillsTargetDir());
        console.log(`  skills: ${steps.filter((s) => s.status === "done").length}/${steps.length} refreshed`);
        const code = await adoptCodeMemoryNow(cfg);
        console.log(
          `  code memory: ${code.pointers} pointer(s) written, ${code.absorbed} fact(s) absorbed, ` +
            `${code.pending} left in place`,
        );
        checks = await runDoctor(cfg);
        console.log("\nAfter:");
        console.log(formatChecks(checks));
      }
      if (checks.some((c) => c.status === "fail")) process.exit(1);
      break;
    }
    case "migrate": {
      const cfg = await loadConfig();
      const res = await migrate(cfg);
      console.log(res.ranAny ? "Migrations applied." : "Already up to date.");
      break;
    }
    case "--help":
    case "-h":
    case "help":
      console.log(HELP);
      break;
    default:
      console.log(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exit(1);
  }
}

main().catch((err) => {
  logError(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});

// Point Claude Code's own memory directories here, and absorb what was written
// there when the config asks for it. Shared by `sync` and `doctor --fix`; the
// server does the same thing on boot.
async function adoptCodeMemoryNow(cfg: Config, force = false): Promise<AdoptionReport> {
  const { adoptCodeMemory, codeMemoryRoot } = await import("./surfaces/code-memory.js");
  const { primaryPaths } = await import("./store/paths.js");
  const { Indexer } = await import("./index/indexer.js");
  const { makeEmbeddingProvider } = await import("./index/embeddings.js");
  const paths = primaryPaths(cfg);
  const idx = Indexer.open(paths, cfg, await makeEmbeddingProvider(cfg.embedding));
  try {
    return await adoptCodeMemory(paths, idx, cfg, codeMemoryRoot(), force);
  } finally {
    idx.close();
  }
}
