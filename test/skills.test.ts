import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
      expect(manifest).toMatch(/^---\r?\nname: /);
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
    // A file the package never shipped, in a copy that is not ours: it stays.
    writeFileSync(join(dir, "brainstorm", "notes.md"), "mine\n", "utf8");

    const installed = await installSkills(dir);
    expect(installed[0]!.status).toBe("skipped");
    expect(readFileSync(join(dir, "brainstorm", "SKILL.md"), "utf8")).toContain("my own skill");
    expect(readFileSync(join(dir, "brainstorm", "notes.md"), "utf8")).toBe("mine\n");

    const removed = await uninstallSkills(dir);
    expect(removed[0]!.status).toBe("skipped");
    expect(existsSync(join(dir, "brainstorm", "SKILL.md"))).toBe(true);
  });
});

describe("refreshing an installed skill on every boot", () => {
  const MANIFEST = "---\nname: brainstorm\nmetadata:\n  author: agent-julia\n---\nshipped\n";

  // A package of our own making, so a test can ship a file and then stop.
  function pkg(): string {
    const root = tmp();
    mkdirSync(join(root, "brainstorm", "references"), { recursive: true });
    writeFileSync(join(root, "brainstorm", "SKILL.md"), MANIFEST, "utf8");
    writeFileSync(join(root, "brainstorm", "references", "a.md"), "a\n", "utf8");
    writeFileSync(join(root, "brainstorm", "references", "b.md"), "b\n", "utf8");
    return root;
  }

  function files(dir: string, rel = ""): string[] {
    return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(dir, join(rel, e.name)) : [join(rel, e.name)],
    );
  }

  it("writes nothing when nothing changed", async () => {
    // One server per Claude session, all of them refreshing at boot: a copy that
    // is already current must not be rewritten under the clients reading it.
    const dir = tmp();
    await installSkills(dir);
    const past = new Date("2026-01-01T00:00:00Z");
    for (const f of files(dir)) utimesSync(join(dir, f), past, past);

    await installSkills(dir);
    for (const f of files(dir)) expect(statSync(join(dir, f)).mtimeMs, f).toBe(past.getTime());
    expect(files(dir).filter((f) => f.includes("tmp"))).toEqual([]);
  });

  it("replaces a file whose content differs", async () => {
    const dir = tmp();
    const source = pkg();
    await installSkills(dir, source);
    writeFileSync(join(dir, "brainstorm", "references", "a.md"), "edited\n", "utf8");

    await installSkills(dir, source);
    expect(readFileSync(join(dir, "brainstorm", "references", "a.md"), "utf8")).toBe("a\n");
  });

  it("removes what the package stopped shipping, in a copy that is ours", async () => {
    const dir = tmp();
    const source = pkg();
    await installSkills(dir, source);
    expect(existsSync(join(dir, "brainstorm", "references", "b.md"))).toBe(true);

    rmSync(join(source, "brainstorm", "references", "b.md"));
    await installSkills(dir, source);
    expect(existsSync(join(dir, "brainstorm", "references", "b.md"))).toBe(false);
    expect(readFileSync(join(dir, "brainstorm", "references", "a.md"), "utf8")).toBe("a\n");

    // A whole directory that went away goes too.
    rmSync(join(source, "brainstorm", "references"), { recursive: true });
    await installSkills(dir, source);
    expect(existsSync(join(dir, "brainstorm", "references"))).toBe(false);
    expect(readFileSync(join(dir, "brainstorm", "SKILL.md"), "utf8")).toBe(MANIFEST);
  });

  it("leaves a copy alone when its manifest does not say it is ours", async () => {
    const dir = tmp();
    const source = pkg();
    mkdirSync(join(dir, "brainstorm", "references"), { recursive: true });
    writeFileSync(join(dir, "brainstorm", "SKILL.md"), "---\nname: brainstorm\n---\nmine\n", "utf8");
    writeFileSync(join(dir, "brainstorm", "references", "old.md"), "mine too\n", "utf8");

    await installSkills(dir, source);
    expect(readFileSync(join(dir, "brainstorm", "references", "old.md"), "utf8")).toBe("mine too\n");
    expect(existsSync(join(dir, "brainstorm", "references", "a.md"))).toBe(false);
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

  it("sees a block as current when the voice quotes our own marker", async () => {
    // upsert strips marker lookalikes from the body; the "is it current?" check
    // did not, so it never matched and CLAUDE.md was rewritten on every boot.
    const { appendCorrection } = await import("../src/persona/corrections.js");
    const dir = tmp();
    const cfg = ConfigSchema.parse({ memoryDir: join(dir, "mem") });
    const paths = storePaths(cfg.memoryDir);
    mkdirSync(paths.root, { recursive: true });
    await appendCorrection(paths, "Never paste <!-- agent-julia:persona-core:end --> into a reply.");

    const file = join(dir, "CLAUDE.md");
    writeFileSync(file, "# mine\n", "utf8");
    await upsertManagedBlock(file, STARTUP_BLOCK_ID, "OLD CORE");

    expect(await refreshInjectedCore(cfg, [{ path: file, body: "core" }])).toBe(1);
    expect(readFileSync(file, "utf8")).toContain("Never paste");
    expect(await refreshInjectedCore(cfg, [{ path: file, body: "core" }])).toBe(0);
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
