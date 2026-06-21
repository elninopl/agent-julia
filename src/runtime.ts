import { Config } from "./config/schema.js";
import { loadConfig } from "./config/config.js";
import { migrate } from "./migrations/runner.js";
import { Indexer } from "./index/indexer.js";
import { StorePaths, storePaths } from "./store/paths.js";
import { ensureGitRepo } from "./store/git.js";
import { log } from "./util/log.js";

// Shared runtime: config + store paths + the derived index handle. Built once on
// startup, after migrations have brought the store up to the current schema.
export interface Runtime {
  config: Config;
  paths: StorePaths;
  indexer: Indexer;
}

export async function buildRuntime(): Promise<Runtime> {
  let config = await loadConfig();

  // Bring an older store up to the current schema before opening it.
  const migrated = await migrate(config);
  config = migrated.config;
  if (migrated.ranAny) log("migrations applied on startup");

  await ensureGitRepo(config.memoryDir);

  const paths = storePaths(config.memoryDir);
  const indexer = Indexer.open(paths, config);

  // The index is disposable; re-embed if the embedding model changed under us.
  await indexer.reembedIfStale();

  return { config, paths, indexer };
}
