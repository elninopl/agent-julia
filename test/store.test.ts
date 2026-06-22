import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Indexer } from "../src/index/indexer.js";
import { storePaths } from "../src/store/paths.js";
import { ingest } from "../src/store/ingest.js";
import { migrate } from "../src/migrations/runner.js";
import { ConfigSchema } from "../src/config/schema.js";

describe("git gating on ingest", () => {
  let close: (() => void) | null = null;
  afterEach(() => close?.());

  async function run(git: boolean) {
    const dir = mkdtempSync(join(tmpdir(), "aj-git-"));
    const cfg = ConfigSchema.parse({ memoryDir: dir, git, search: "fts" });
    await migrate(cfg);
    const paths = storePaths(dir);
    const indexer = Indexer.open(paths, cfg);
    close = () => indexer.close();
    const res = await ingest(paths, indexer, "note", "a durable fact", { git: cfg.git });
    return { dir, res };
  }

  it("commits when git is on", async () => {
    const { dir, res } = await run(true);
    expect(res.committed).toBe(true);
    expect(existsSync(join(dir, ".git"))).toBe(true);
  });

  it("does not commit or create a repo when git is off", async () => {
    const { dir, res } = await run(false);
    expect(res.committed).toBe(false);
    expect(existsSync(join(dir, ".git"))).toBe(false);
    // the page is still written
    expect(existsSync(join(dir, "pages", "note.md"))).toBe(true);
  });
});
