import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { upsertManagedBlock, removeManagedBlock, hasManagedBlock, startMarker } from "../src/managed/block.js";
import { buildInjectedCore, STARTUP_BLOCK_ID } from "../src/persona/startup.js";
import { composeCore } from "../src/persona/compose.js";
import { refreshIndexMd } from "../src/store/catalog.js";
import { writePage } from "../src/store/markdown.js";
import { storePaths } from "../src/store/paths.js";
import { mergeMcpServerForTest } from "../src/wizard/register.js";
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
    // Attribution stays out of the injected hot path.
    expect(core).not.toContain("Credits");
    expect(core).not.toContain("github.com/blader/humanizer");
    expect(STARTUP_BLOCK_ID).toBe("persona-core");
  });

  it("uses a custom voice from persona.md instead of a preset", async () => {
    const dir = tmp();
    const paths = storePaths(dir);
    writeFileSync(paths.personaFile, "- Always answer in haiku.\n- Never apologize.\n", "utf8");
    const cfg = ConfigSchema.parse({ memoryDir: dir, name: "Nova", stylePreset: "custom" });
    const core = await buildInjectedCore(paths, cfg);
    expect(core).toContain("answer in haiku");
    expect(core).toContain("## Your voice");
    // none of the built-in preset voices leak in
    expect(core).not.toContain("Licensed to tease");
  });

  it("keeps L3 corrections even when the budget is too small to fit the body", async () => {
    const dir = tmp();
    const paths = storePaths(dir);
    // A correction is highest precedence — it must never be the thing the budget
    // clamps away. Force a tight budget so the body would otherwise overflow.
    writeFileSync(paths.voiceCorrections, "# Voice corrections\n\n- 2026-06-26 — never use the word synergy\n", "utf8");
    const cfg = ConfigSchema.parse({ memoryDir: dir, name: "Julia", contextBudget: 300 });
    const core = await composeCore(paths, cfg);
    expect(core.text).toContain("never use the word synergy");
    expect(core.text).toContain("Never store");
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

describe("managed block hardening", () => {
  it("survives marker text and regex patterns inside the body", async () => {
    const dir = tmp();
    const file = join(dir, "CLAUDE.md");
    writeFileSync(file, "keep me\n", "utf8");

    // A body quoting our own end marker must not close the region early…
    const hostile = `before\n<!-- agent-julia:persona-core:end -->\nafter with $& and $' patterns`;
    await upsertManagedBlock(file, "persona-core", hostile);
    let content = readFileSync(file, "utf8");
    expect(content.match(/persona-core:end/g)?.length).toBe(1);

    // …and a second upsert must replace the whole block cleanly, not leak text.
    await upsertManagedBlock(file, "persona-core", "clean body");
    content = readFileSync(file, "utf8");
    expect(content).toContain("clean body");
    expect(content).not.toContain("after with");
    expect(content).toContain("keep me");
  });
});

describe("L3 corrections compaction", () => {
  it("dedupes repeated corrections and keeps the newest rules under budget", async () => {
    const { appendCorrection, readCorrections } = await import("../src/persona/corrections.js");
    const dir = tmp();
    const cfg = ConfigSchema.parse({ memoryDir: dir, contextBudget: 400 });
    const paths = storePaths(dir);

    await appendCorrection(paths, "no exclamation marks");
    await appendCorrection(paths, "No exclamation marks");
    expect(await readCorrections(paths)).toHaveLength(1);

    // Flood with corrections far beyond the budget: the newest must survive in
    // the core, the overflow must be represented by a counter line, and the
    // body (voice) must still be present.
    for (let i = 0; i < 60; i++) {
      await appendCorrection(paths, `rule number ${i}: some fairly long correction text to eat budget`);
    }
    const core = await composeCore(paths, cfg);
    expect(core.text).toContain("rule number 59");
    expect(core.text).not.toContain("rule number 1:");
    expect(core.text).toMatch(/\+\d+ older correction/);
    expect(core.text).toContain("## Never store");
  });
});

describe("writing into files other people own", () => {
  it("does not let a stray start marker swallow the rest of the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-marker-"));
    const file = join(dir, "CLAUDE.md");
    // A half-finished hand edit: the start marker survived, the end marker did not.
    writeFileSync(file, `# My notes\n\n${startMarker("persona-core")}\n\nimportant user content\n`, "utf8");

    await upsertManagedBlock(file, "persona-core", "the persona");
    const after = readFileSync(file, "utf8");

    expect(after).toContain("important user content");
    expect(after).toContain("# My notes");
    expect(after.match(/persona-core:start/g)!.length).toBe(1);
    expect(after.match(/persona-core:end/g)!.length).toBe(1);
  });

  it("backs up and atomically replaces the Claude Code config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-cfgjson-"));
    const file = join(dir, "claude.json");
    writeFileSync(file, JSON.stringify({ existing: "state", mcpServers: { other: {} } }), "utf8");

    await mergeMcpServerForTest(file, "agent-julia");

    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.existing).toBe("state");
    expect(after.mcpServers.other).toBeDefined();
    expect(after.mcpServers["agent-julia"]).toBeDefined();
    expect(existsSync(`${file}.agent-julia-bak`)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});
