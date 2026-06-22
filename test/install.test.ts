import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { upsertManagedBlock, removeManagedBlock, hasManagedBlock } from "../src/managed/block.js";
import { buildInjectedCore, STARTUP_BLOCK_ID } from "../src/persona/startup.js";
import { refreshIndexMd } from "../src/store/catalog.js";
import { writePage } from "../src/store/markdown.js";
import { storePaths } from "../src/store/paths.js";
import { ConfigSchema } from "../src/config/schema.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "aj-test-"));
}

describe("managed block", () => {
  it("preserves surrounding content on upsert, replaces in place, and removes cleanly", async () => {
    const dir = tmp();
    const file = join(dir, "CLAUDE.md");
    writeFileSync(file, "# My instructions\n\nkeep me\n", "utf8");

    await upsertManagedBlock(file, "persona-core", "BLOCK V1");
    let content = readFileSync(file, "utf8");
    expect(content).toContain("keep me");
    expect(content).toContain("BLOCK V1");
    expect(hasManagedBlock(content, "persona-core")).toBe(true);
    // one-time backup of the pre-agent-julia original
    expect(existsSync(`${file}.agent-julia-bak`)).toBe(true);

    await upsertManagedBlock(file, "persona-core", "BLOCK V2");
    content = readFileSync(file, "utf8");
    expect(content).toContain("BLOCK V2");
    expect(content).not.toContain("BLOCK V1");
    expect(content.match(/persona-core:start/g)?.length).toBe(1);

    await removeManagedBlock(file, "persona-core");
    content = readFileSync(file, "utf8");
    expect(content).toContain("keep me");
    expect(content).not.toContain("BLOCK V2");
    expect(hasManagedBlock(content, "persona-core")).toBe(false);
  });
});

describe("injected core", () => {
  it("carries the persona and the memory instruction", async () => {
    const dir = tmp();
    const cfg = ConfigSchema.parse({ memoryDir: dir, name: "Julia", language: "pl" });
    const core = await buildInjectedCore(storePaths(dir), cfg);
    expect(core).toContain("Julia");
    expect(core).toContain("ingest");
    expect(core).toContain("search");
    expect(STARTUP_BLOCK_ID).toBe("persona-core");
  });

  it("uses a custom voice from persona.md instead of a preset", async () => {
    const dir = tmp();
    const paths = storePaths(dir);
    writeFileSync(paths.personaFile, "- Always answer in haiku.\n- Never apologize.\n", "utf8");
    const cfg = ConfigSchema.parse({ memoryDir: dir, name: "Nova", stylePreset: "custom" });
    const core = await buildInjectedCore(paths, cfg);
    expect(core).toContain("answer in haiku");
    expect(core).toContain("Custom voice");
    // none of the built-in preset voices leak in
    expect(core).not.toContain("Licensed to tease");
  });
});

describe("adoption: refreshIndexMd never clobbers a hand-written index.md", () => {
  it("keeps user content and only owns the managed catalog block", async () => {
    const dir = tmp();
    const paths = storePaths(dir);
    // Simulate an adopted KB: hand-written index.md + an existing page.
    writeFileSync(paths.indexMd, "# My curated wiki index\n\nhand-written notes here\n", "utf8");
    await writePage(paths, "elnino", "Serial entrepreneur.", {});

    await refreshIndexMd(paths);
    const content = readFileSync(paths.indexMd, "utf8");
    expect(content).toContain("hand-written notes here");
    expect(content).toContain("[[elnino]]");
    expect(hasManagedBlock(content, "catalog")).toBe(true);
  });
});
