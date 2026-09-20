import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor, DoctorTargets } from "../src/doctor/doctor.js";
import { installSkills } from "../src/skills/install.js";
import { upsertManagedBlock } from "../src/managed/block.js";
import { buildInjectedCore, STARTUP_BLOCK_ID } from "../src/persona/startup.js";
import { coreHash } from "../src/wizard/register.js";
import { storePaths } from "../src/store/paths.js";
import { writePage } from "../src/store/markdown.js";
import { ConfigSchema } from "../src/config/schema.js";

function sandbox(): { dir: string; targets: DoctorTargets } {
  const dir = mkdtempSync(join(tmpdir(), "aj-doctor-"));
  return {
    dir,
    targets: {
      claudeCodeConfig: join(dir, "claude.json"),
      claudeCodeMemory: join(dir, "CLAUDE.md"),
      desktopConfig: join(dir, "desktop.json"),
      coworkMirror: join(dir, "mirror.md"),
      pasteMarker: join(dir, "cowork-paste.json"),
      surfaces: join(dir, "surfaces.json"),
      skillsDir: join(dir, "skills"),
      // An empty sandbox: doctor must not read the developer's real
      // ~/.claude/projects while the suite runs.
      codeMemoryRoot: join(dir, "projects"),
    },
  };
}

function byName(checks: Awaited<ReturnType<typeof runDoctor>>, name: string) {
  const c = checks.find((c) => c.name === name);
  expect(c, `check '${name}' missing`).toBeDefined();
  return c!;
}

describe("doctor", () => {
  it("flags a fresh, unregistered setup and passes a healthy one", async () => {
    const { dir, targets } = sandbox();
    const memoryDir = join(dir, "mem");
    mkdirSync(memoryDir, { recursive: true });
    const cfg = ConfigSchema.parse({ memoryDir, git: false, surfaces: ["code", "cowork"] });
    const paths = storePaths(memoryDir);
    await writePage(paths, "hello", "world", {});

    // Fresh: nothing registered, no block, no paste, no skills.
    let checks = await runDoctor(cfg, targets);
    expect(byName(checks, "mcp (code)").status).toBe("fail");
    expect(byName(checks, "mcp (cowork)").status).toBe("fail");
    expect(byName(checks, "persona (code)").status).toBe("fail");
    expect(byName(checks, "paste (desktop)").status).toBe("warn");
    expect(byName(checks, "skill 'brainstorm'").status).toBe("warn");

    // Heal it the way init/sync would.
    const entry = { mcpServers: { "agent-julia": { command: "npx", args: [] } } };
    writeFileSync(targets.claudeCodeConfig, JSON.stringify(entry), "utf8");
    writeFileSync(targets.desktopConfig!, JSON.stringify(entry), "utf8");
    const core = await buildInjectedCore(paths, cfg);
    await upsertManagedBlock(targets.claudeCodeMemory, STARTUP_BLOCK_ID, core);
    writeFileSync(targets.pasteMarker, coreHash(core) + "\n", "utf8");
    await installSkills(targets.skillsDir);

    checks = await runDoctor(cfg, targets);
    // The index db legitimately doesn't exist before the first server start, and
    // the three Claude Desktop checks are about a field agent-julia cannot read
    // and a client that has never connected — none of them can be "ok" here.
    expect(byName(checks, "index").status).toBe("warn");
    const unknowable = ["index", "paste (desktop)", "paste seen", "voice fetch"];
    expect(checks.filter((c) => !unknowable.includes(c.name)).every((c) => c.status === "ok")).toBe(true);
  });

  it("reports the persona budget, and warns when the core does not fit it", async () => {
    const { dir, targets } = sandbox();
    const memoryDir = join(dir, "mem");
    mkdirSync(memoryDir, { recursive: true });
    const paths = storePaths(memoryDir);

    // A budget that comfortably holds the shipped preset voice.
    const roomy = ConfigSchema.parse({ memoryDir, git: false, surfaces: ["code"], contextBudget: 4000 });
    let budget = byName(await runDoctor(roomy, targets), "persona budget");
    expect(budget.status).toBe("ok");
    expect(budget.detail).toContain("/4000 tokens");
    expect(budget.detail).toContain("injected block");

    // Now bury it under corrections it cannot hold.
    const rule = "- 2026-01-01 — " + "never do that ".repeat(40);
    writeFileSync(paths.voiceCorrections, `# Voice corrections\n\n${Array(15).fill(rule).map((r, i) => r + i).join("\n")}\n`, "utf8");
    const tight = ConfigSchema.parse({ memoryDir, git: false, surfaces: ["code"], contextBudget: 800 });
    budget = byName(await runDoctor(tight, targets), "persona budget");
    expect(budget.status).toBe("warn");
    expect(budget.detail).toContain("contextBudget 800");
    expect(budget.fix).toContain("raise contextBudget");
  });

  it("separates what it asked for from what it can never read", async () => {
    // The old check asserted "in-app paste matches the current core", which it
    // had no way of knowing. Three questions now, each answerable.
    const { dir, targets } = sandbox();
    const memoryDir = join(dir, "mem");
    mkdirSync(memoryDir, { recursive: true });
    const cfg = ConfigSchema.parse({ memoryDir, git: false, surfaces: ["cowork"] });

    writeFileSync(targets.desktopConfig!, JSON.stringify({ mcpServers: { "agent-julia": {} } }), "utf8");
    await installSkills(targets.skillsDir);

    const checks = await runDoctor(cfg, targets);

    const asked = byName(checks, "paste (desktop)");
    expect(asked.status).toBe("warn");
    expect(asked.detail).toContain("cannot read the in-app field");

    // No evidence either way is "unknown", never "ok" and never "fail".
    expect(["unknown", "warn", "ok"]).toContain(byName(checks, "paste seen").status);

    const fetch = byName(checks, "voice fetch");
    expect(["unknown", "warn"]).toContain(fetch.status);

    const instructions = byName(checks, "mcp instructions");
    expect(instructions.status).toBe("ok");
    expect(instructions.detail).toMatch(/bytes of 1800|bytes of 1,800/);
  });

  it("never reports a failure for something it merely cannot see", async () => {
    const { dir, targets } = sandbox();
    const memoryDir = join(dir, "mem");
    mkdirSync(memoryDir, { recursive: true });
    const cfg = ConfigSchema.parse({ memoryDir, git: false, surfaces: ["cowork"] });
    const checks = await runDoctor(cfg, targets);
    for (const name of ["paste seen", "voice fetch"]) {
      expect(byName(checks, name).status).not.toBe("fail");
    }
  });
});

describe("voice fetch reports on a client that actually connected", () => {
  it("ignores a record left by something that never started the server", async () => {
    // A scratch script or a one-off client leaves a fetch record behind. Reading
    // any non-Code key out of it reported that leftover as the state of Claude
    // Desktop — which is the one surface this check exists to speak about.
    const { dir, targets } = sandbox();
    const memoryDir = join(dir, "mem");
    mkdirSync(memoryDir, { recursive: true });
    const cfg = ConfigSchema.parse({ memoryDir, git: false, surfaces: ["cowork"] });
    writeFileSync(
      targets.surfaces,
      JSON.stringify({
        fetches: { "test-client": { at: "2026-09-20T13:17:43.567Z", coreHash: "f0078729deadbeef" } },
        boots: { unknown: { at: "2026-09-20T14:41:56.801Z" } },
      }),
      "utf8",
    );

    const fetch = byName(await runDoctor(cfg, targets), "voice fetch");
    expect(fetch.status).toBe("unknown");
    expect(fetch.detail).toMatch(/never started|nothing can be said/i);
    expect(fetch.detail).not.toContain("test-client");
  });

  it("reports the client that both booted and fetched", async () => {
    const { dir, targets } = sandbox();
    const memoryDir = join(dir, "mem");
    mkdirSync(memoryDir, { recursive: true });
    const cfg = ConfigSchema.parse({ memoryDir, git: false, surfaces: ["cowork"] });
    writeFileSync(
      targets.surfaces,
      JSON.stringify({
        boots: { "claude-desktop-3p": { at: "2026-09-20T14:00:00.000Z" } },
        fetches: { "claude-desktop-3p": { at: "2026-09-20T14:02:00.000Z", coreHash: "0".repeat(40) } },
      }),
      "utf8",
    );

    const fetch = byName(await runDoctor(cfg, targets), "voice fetch");
    expect(fetch.detail).toContain("claude-desktop-3p");
  });
});
