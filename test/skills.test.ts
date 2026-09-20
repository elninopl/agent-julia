import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { installSkills, uninstallSkills, SHIPPED_SKILLS } from "../src/skills/install.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "aj-skills-"));
}

describe("shipped skills", () => {
  it("packages every declared skill with a valid manifest", () => {
    for (const skill of SHIPPED_SKILLS) {
      const here = dirname(fileURLToPath(import.meta.url));
      const manifest = readFileSync(join(here, "..", "src", "skills", "assets", skill, "SKILL.md"), "utf8");
      expect(manifest).toMatch(/^---\nname: /);
      expect(manifest).toContain(`name: ${skill}`);
      expect(manifest).toContain("author: agent-julia");
    }
  });

  it("installs, is idempotent, and uninstalls only its own copies", async () => {
    const dir = tmp();

    let steps = await installSkills(dir);
    expect(steps.every((s) => s.status === "done")).toBe(true);
    expect(existsSync(join(dir, "brainstorm", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, "brainstorm", "references", "process.md"))).toBe(true);

    // Re-install overwrites our own copy without complaint.
    steps = await installSkills(dir);
    expect(steps.every((s) => s.status === "done")).toBe(true);

    steps = await uninstallSkills(dir);
    expect(steps.every((s) => s.status === "done")).toBe(true);
    expect(existsSync(join(dir, "brainstorm"))).toBe(false);
  });

  it("never touches a user's own skill under the same name", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "brainstorm"), { recursive: true });
    writeFileSync(join(dir, "brainstorm", "SKILL.md"), "---\nname: brainstorm\n---\nmy own skill\n", "utf8");

    const installed = await installSkills(dir);
    expect(installed[0]!.status).toBe("skipped");
    expect(readFileSync(join(dir, "brainstorm", "SKILL.md"), "utf8")).toContain("my own skill");

    const removed = await uninstallSkills(dir);
    expect(removed[0]!.status).toBe("skipped");
    expect(existsSync(join(dir, "brainstorm", "SKILL.md"))).toBe(true);
  });
});

describe("persona block boot refresh", async () => {
  const { refreshInjectedCore } = await import("../src/wizard/register.js");
  const { buildInjectedCore, STARTUP_BLOCK_ID } = await import("../src/persona/startup.js");
  const { upsertManagedBlock } = await import("../src/managed/block.js");
  const { storePaths } = await import("../src/store/paths.js");
  const { ConfigSchema } = await import("../src/config/schema.js");

  it("updates stale blocks, skips current ones, and never creates a block", async () => {
    const dir = tmp();
    const cfg = ConfigSchema.parse({ memoryDir: join(dir, "mem") });

    const stale = join(dir, "CLAUDE.md");
    writeFileSync(stale, "# mine\n", "utf8");
    await upsertManagedBlock(stale, STARTUP_BLOCK_ID, "OLD CORE");

    const noBlock = join(dir, "no-block.md");
    writeFileSync(noBlock, "# untouched\n", "utf8");

    let n = await refreshInjectedCore(cfg, [
      { path: stale, body: "core" },
      { path: noBlock, body: "core" },
      { path: join(dir, "missing.md"), body: "core" },
    ]);
    expect(n).toBe(1);
    const refreshed = readFileSync(stale, "utf8");
    expect(refreshed).not.toContain("OLD CORE");
    expect(refreshed).toContain(await buildInjectedCore(storePaths(cfg.memoryDir), cfg).then((c) => c.split("\n")[0]));
    expect(refreshed).toContain("# mine");
    expect(readFileSync(noBlock, "utf8")).toBe("# untouched\n");
    expect(existsSync(join(dir, "missing.md"))).toBe(false);

    // Second pass: everything current, nothing rewritten.
    n = await refreshInjectedCore(cfg, [{ path: stale, body: "core" }, { path: noBlock, body: "core" }]);
    expect(n).toBe(0);
  });
});

describe("the two surfaces get different bodies", async () => {
  const { refreshInjectedCore } = await import("../src/wizard/register.js");
  const { STARTUP_BLOCK_ID } = await import("../src/persona/startup.js");
  const { upsertManagedBlock } = await import("../src/managed/block.js");
  const { ConfigSchema } = await import("../src/config/schema.js");
  const { storePaths } = await import("../src/store/paths.js");

  it("writes the full core for Claude Code and the stable paste for Desktop", async () => {
    // Claude Code's file is rewritten on every boot and can carry the volatile
    // voice. The Desktop mirror is only ever copied by hand, so anything in it
    // that changes between pastes is stale by construction.
    const dir = tmp();
    const cfg = ConfigSchema.parse({ memoryDir: join(dir, "mem") });
    const paths = storePaths(cfg.memoryDir);
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.voiceCorrections, "# Voice corrections\n\n- 2026-01-01 — Never say moat.\n", "utf8");

    const code = join(dir, "CLAUDE.md");
    const mirror = join(dir, "mirror.md");
    for (const f of [code, mirror]) {
      writeFileSync(f, "# mine\n", "utf8");
      await upsertManagedBlock(f, STARTUP_BLOCK_ID, "OLD");
    }

    await refreshInjectedCore(cfg, [
      { path: code, body: "core" },
      { path: mirror, body: "paste" },
    ]);

    expect(readFileSync(code, "utf8")).toContain("moat");
    expect(readFileSync(mirror, "utf8")).not.toContain("moat");
    expect(readFileSync(mirror, "utf8")).toContain("layout 2");
  });
});
