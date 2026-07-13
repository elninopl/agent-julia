#!/usr/bin/env node
import { startServer } from "./server.js";
import { runWizard } from "./wizard/wizard.js";
import { buildInstructions, install, uninstall } from "./wizard/register.js";
import { loadConfig, saveConfig } from "./config/config.js";
import { migrate } from "./migrations/runner.js";
import { ensureGitRepo, getRemoteUrl, pushToRemote, setRemoteUrl, verifyRemote } from "./store/git.js";
import { logError } from "./util/log.js";

const HELP = `agent-julia — one brain for your AI

Usage:
  agent-julia serve      Start the MCP stdio server (default; used by Claude clients)
  agent-julia init       Run the interactive setup wizard
  agent-julia sync       Re-apply MCP registration + persona core + shipped skills (add --print to show the steps instead)
  agent-julia uninstall  Remove the managed persona blocks, MCP registration, and shipped skills
  agent-julia remote [url]  Show or set the git remote backing up your memory
  agent-julia push       Push the memory store to its remote now
  agent-julia pull       Pull the memory store from its remote now (two-machine sync)
  agent-julia maintenance  Run store maintenance now (reindex, flag stale/orphans, refresh catalog, commit)
  agent-julia doctor     Check the whole installation: registration, persona blocks, Cowork drift, skills, store
  agent-julia search <query>   Search your memory from the terminal
  agent-julia read <page>      Print one memory page
  agent-julia export [target]  Export the persona to another tool's instruction file (codex, gemini, or a path); no target prints it
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

async function main(): Promise<void> {
  assertNodeVersion();
  const cmd = process.argv[2] ?? "serve";

  switch (cmd) {
    case "serve":
      await startServer();
      break;
    case "init":
    case "wizard":
      await runWizard();
      break;
    case "sync": {
      const cfg = await loadConfig();
      if (process.argv.includes("--print")) {
        console.log(await buildInstructions(cfg));
      } else {
        const steps = await install(cfg);
        for (const s of steps) console.log(`[${s.status}] ${s.surface} — ${s.action}: ${s.detail}`);
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
      const { storePaths } = await import("./store/paths.js");
      const { Indexer } = await import("./index/indexer.js");
      const idx = Indexer.open(storePaths(cfg.memoryDir), cfg);
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
      const { storePaths } = await import("./store/paths.js");
      const { readPage } = await import("./store/markdown.js");
      const found = await readPage(storePaths(cfg.memoryDir), page);
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
      const { storePaths } = await import("./store/paths.js");
      const { Indexer } = await import("./index/indexer.js");
      const { runMaintenance } = await import("./maintenance/maintenance.js");
      const idx = Indexer.open(storePaths(cfg.memoryDir), cfg);
      try {
        const r = await runMaintenance(storePaths(cfg.memoryDir), idx, cfg, "auto");
        console.log(
          `Maintenance done: +${r.indexAdded}/~${r.indexUpdated}/-${r.indexRemoved} indexed, ` +
            `${r.staleFlagged.length} stale-flagged, ${r.orphanLinks.length} orphan link(s), ` +
            `core ${r.coreTokens}/${r.coreBudget} tokens${r.committed ? ", committed" : ""}${r.pushed ? ", pushed" : ""}.`,
        );
        console.log("For the interactive digest (merge/retire proposals), ask your agent to run the weekly digest.");
      } finally {
        idx.close();
      }
      break;
    }
    case "doctor": {
      const cfg = await loadConfig();
      const { runDoctor, formatChecks } = await import("./doctor/doctor.js");
      const checks = await runDoctor(cfg);
      console.log(formatChecks(checks));
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
