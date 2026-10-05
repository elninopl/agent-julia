import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/migrations/runner.js";
import { ConfigSchema, CURRENT_SCHEMA_VERSION } from "../src/config/schema.js";
import { storePaths } from "../src/store/paths.js";

const configBefore = process.env.AGENT_JULIA_CONFIG;
afterEach(() => {
  process.env.AGENT_JULIA_CONFIG = configBefore;
});

describe("migrating a store that several servers open at once", () => {
  it("migrates once; the rest wait and find it done", async () => {
    // The first boots after an upgrade arrive together, one server per
    // session. Each used to back up, migrate and save the config, and the
    // config backup ring filled with copies written after the migration.
    const store = mkdtempSync(join(tmpdir(), "aj-migrate-"));
    const configFile = join(mkdtempSync(join(tmpdir(), "aj-migrate-cfg-")), "config.json");
    process.env.AGENT_JULIA_CONFIG = configFile;
    const config = ConfigSchema.parse({ memoryDir: store, git: false, search: "fts" });
    writeFileSync(configFile, JSON.stringify(config), "utf8");
    // A store with content and no recorded schema: the migration backs it up.
    writeFileSync(join(store, "index.md"), "# Index\n", "utf8");

    const results = await Promise.all([migrate(config), migrate(config), migrate(config), migrate(config)]);

    expect(results.filter((r) => r.ranAny)).toHaveLength(1);
    for (const r of results) expect(r.config.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    // One save, so one backup of the config as it was before.
    expect(existsSync(`${configFile}.1.bak`)).toBe(true);
    expect(existsSync(`${configFile}.2.bak`)).toBe(false);
    const state = JSON.parse(readFileSync(storePaths(store).migrationStatePath, "utf8")) as {
      applied: number[];
      schemaVersion: number;
    };
    expect(state).toEqual({ applied: [1], schemaVersion: CURRENT_SCHEMA_VERSION });

    // And a later boot has nothing to do.
    expect((await migrate(config)).ranAny).toBe(false);
    expect(existsSync(`${configFile}.2.bak`)).toBe(false);
  });
});
