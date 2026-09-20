import { Config } from "./config/schema.js";
import { configBackups, configPath, loadConfig } from "./config/config.js";
import { migrate } from "./migrations/runner.js";
import { existsSync } from "node:fs";
import { Indexer } from "./index/indexer.js";
import { StorePaths, storePaths } from "./store/paths.js";
import { ensureGitRepo, gitAvailable } from "./store/git.js";
import { log, warn } from "./util/log.js";

// Shared runtime: config + store paths + the derived index handle. Built once on
// startup, after migrations have brought the store up to the current schema.
export interface Runtime {
  config: Config;
  paths: StorePaths;
  indexer: Indexer;
}

export async function buildRuntime(): Promise<Runtime> {
  let config = await loadConfig();

  // A configured store that is no longer there is the shape of a corrupted or
  // overwritten config, not of a fresh install: openDb would happily create an
  // empty one and the agent would start insisting it knows nothing about you.
  // Say so where someone can see it, and point at the backups.
  if (!existsSync(config.memoryDir)) {
    const backups = configBackups();
    warn(
      `the configured memory directory does not exist: ${config.memoryDir}. ` +
        "agent-julia will start with an EMPTY store. If this is not a fresh install, your config at " +
        `${configPath()} may have been overwritten` +
        (backups.length ? `; previous versions: ${backups.join(", ")}` : "") +
        ".",
    );
  }

  // Bring an older store up to the current schema before opening it.
  const migrated = await migrate(config);
  config = migrated.config;
  if (migrated.ranAny) log("migrations applied on startup");

  if (config.git && !(await gitAvailable())) {
    warn(
      "git is not on PATH — history is off for this session. Your memory is still written as plain " +
        "markdown; install git (on macOS: xcode-select --install) to get versioning back.",
    );
    config = { ...config, git: false };
  }
  if (config.git) await ensureGitRepo(config.memoryDir);

  const paths = storePaths(config.memoryDir);
  const indexer = Indexer.open(paths, config);

  // The index is disposable; re-embed if the embedding model changed under us.
  await indexer.reembedIfStale();

  return { config, paths, indexer };
}
