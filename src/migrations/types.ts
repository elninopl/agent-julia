import { Config } from "../config/schema.js";
import { StorePaths } from "../store/paths.js";

export interface MigrationContext {
  paths: StorePaths;
  config: Config;
  // Snapshot the store (git tag/backup) before a destructive markdown rewrite.
  backup: (label: string) => Promise<string>;
  // Commit markdown changes the migration made.
  commit: (message: string) => Promise<boolean>;
}

// A single ordered, idempotent migration step. `version` is the schemaVersion the
// store reaches AFTER this step runs. Steps must be safe to re-run.
export interface Migration {
  version: number;
  description: string;
  // Mutate markdown/config as needed. Index migrations are unnecessary — the index
  // is disposable and rebuilt separately on any mismatch.
  up(ctx: MigrationContext): Promise<void>;
}
