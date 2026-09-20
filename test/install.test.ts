import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
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

describe("registering a launcher that can do the job", () => {
  it("writes the entry it was handed, and keeps the rest of the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-entry-"));
    const file = join(dir, "claude.json");
    writeFileSync(file, JSON.stringify({ keep: "me" }), "utf8");

    await mergeMcpServerForTest(file, "agent-julia", { command: "/opt/x/agent-julia", args: ["serve"] });

    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.keep).toBe("me");
    expect(after.mcpServers["agent-julia"]).toEqual({ command: "/opt/x/agent-julia", args: ["serve"] });
  });
});

describe("the files this package writes in someone else's home", () => {
  it("creates a missing parent directory instead of failing on the lock", async () => {
    // The lockfile lives next to the target, so a missing parent used to fail
    // there with ENOENT — which is every fresh install, where neither ~/.claude
    // nor ~/.config/agent-julia exists yet.
    const dir = join(mkdtempSync(join(tmpdir(), "aj-fresh-")), "never", "existed");
    const res = await upsertManagedBlock(join(dir, "CLAUDE.md"), "persona-core", "hello");
    expect(res.created).toBe(true);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toContain("hello");
  });

  it("writes through a symlink instead of replacing it", async () => {
    // A dotfiles repo commonly symlinks ~/.claude/CLAUDE.md. Renaming onto the
    // link would replace it with a regular file and quietly detach the repo.
    const dir = mkdtempSync(join(tmpdir(), "aj-link-"));
    const real = join(dir, "real.md");
    const link = join(dir, "CLAUDE.md");
    writeFileSync(real, "# from the dotfiles repo\n", "utf8");
    symlinkSync(real, link);

    await upsertManagedBlock(link, "persona-core", "the persona");

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toContain("the persona");
    expect(readFileSync(real, "utf8")).toContain("from the dotfiles repo");
  });

  it("writes through a symlink whose target does not exist yet", async () => {
    // A dotfiles checkout that carries the link but not the file yet. realpath
    // refuses a link like that, and falling back to the link's own path
    // replaced the link with a regular file on exactly the install where the
    // repo has not been populated.
    const dir = mkdtempSync(join(tmpdir(), "aj-link2-"));
    const real = join(dir, "dotfiles", "CLAUDE.md");
    const link = join(dir, "CLAUDE.md");
    mkdirSync(join(dir, "dotfiles"));
    symlinkSync(real, link);

    await upsertManagedBlock(link, "persona-core", "the persona");

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toContain("the persona");
    expect(readdirSync(dir).filter((f) => f.includes(".tmp") || f.includes("lock"))).toEqual([]);
  });

  it("lets two concurrent writers both land", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-conc-"));
    const file = join(dir, "CLAUDE.md");
    writeFileSync(file, "# mine\n", "utf8");
    await Promise.all([
      upsertManagedBlock(file, "persona-core", "core body"),
      upsertManagedBlock(file, "other-block", "other body"),
    ]);
    const after = readFileSync(file, "utf8");
    expect(after).toContain("# mine");
    expect(after).toContain("core body");
    expect(after).toContain("other body");
    expect(readdirSync(dir).filter((f) => f.includes(".tmp") || f.includes("lock"))).toEqual([]);
  });
});

describe("the lock protects the file it is named after", () => {
  it("skips a write it cannot take the lock for, rather than racing the holder", async () => {
    // Writing unlocked is a read-modify-write against a live writer on a file
    // holding someone's hand-written profile. A skipped refresh costs one boot;
    // a raced one costs lines the user typed.
    const dir = mkdtempSync(join(tmpdir(), "aj-busy-"));
    const file = join(dir, "CLAUDE.md");
    writeFileSync(file, "# my own notes\n", "utf8");
    writeFileSync(`${file}.agent-julia-lock`, "99999:someone-else", "utf8");

    await expect(upsertManagedBlock(file, "persona-core", "should not land")).rejects.toThrow(/lock/i);
    expect(readFileSync(file, "utf8")).toBe("# my own notes\n");
  }, 15_000);

  it("removes a block under the same lock, atomically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aj-rm-"));
    const file = join(dir, "CLAUDE.md");
    writeFileSync(file, "# mine\n", "utf8");
    await upsertManagedBlock(file, "persona-core", "the persona");
    expect(await removeManagedBlock(file, "persona-core")).toBe(true);
    const after = readFileSync(file, "utf8");
    expect(after).toContain("# mine");
    expect(after).not.toContain("the persona");
    expect(readdirSync(dir).filter((f) => f.includes(".tmp") || f.includes("lock"))).toEqual([]);
  });
});
