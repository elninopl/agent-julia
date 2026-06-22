#!/usr/bin/env node
import { startServer } from "./server.js";
import { runWizard } from "./wizard/wizard.js";
import { buildInstructions, install, uninstall } from "./wizard/register.js";
import { loadConfig, saveConfig } from "./config/config.js";
import { migrate } from "./migrations/runner.js";
import { ensureGitRepo, getRemoteUrl, pushToRemote, setRemoteUrl } from "./store/git.js";
import { logError } from "./util/log.js";

const HELP = `agent-julia — one brain for your AI

Usage:
  agent-julia serve      Start the MCP stdio server (default; used by Claude clients)
  agent-julia init       Run the interactive setup wizard
  agent-julia sync       Re-apply MCP registration + persona core (add --print to show the steps instead)
  agent-julia uninstall  Remove the managed persona blocks and MCP registration
  agent-julia remote [url]  Show or set the git remote backing up your memory
  agent-julia push       Push the memory store to its remote now
  agent-julia migrate    Run pending data migrations and exit
  agent-julia --help     Show this help
`;

async function main(): Promise<void> {
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
      const ok = await pushToRemote(cfg.memoryDir);
      console.log(`Remote set to ${url}. ${ok ? "Pushed." : "Push skipped/failed (will retry on maintenance)."}`);
      break;
    }
    case "push": {
      const cfg = await loadConfig();
      const ok = cfg.git ? await pushToRemote(cfg.memoryDir) : false;
      console.log(ok ? "Pushed to remote." : "Nothing pushed (no remote, git off, or push failed).");
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
