#!/usr/bin/env node
import { startServer } from "./server.js";
import { runWizard } from "./wizard/wizard.js";
import { loadConfig } from "./config/config.js";
import { migrate } from "./migrations/runner.js";
import { logError } from "./util/log.js";

const HELP = `agent-julia — one brain for your AI

Usage:
  agent-julia serve     Start the MCP stdio server (default; used by Claude clients)
  agent-julia init      Run the interactive setup wizard
  agent-julia migrate   Run pending data migrations and exit
  agent-julia --help    Show this help
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
