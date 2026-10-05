import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
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
import { appendCorrection } from "../src/persona/corrections.js";

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
      // Likewise Claude Desktop's session tree.
      coworkSessions: [join(dir, "sessions")],
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

  it("asks for a re-paste only on the strength of the newest Desktop session", async () => {
    const { dir, targets } = sandbox();
    const memoryDir = join(dir, "mem");
    mkdirSync(memoryDir, { recursive: true });
    const cfg = ConfigSchema.parse({ memoryDir, git: false, surfaces: ["cowork"] });
    const seed = (name: string, content: string, day: string) => {
      const claudeDir = join(targets.coworkSessions[0]!, "acct", "org", name, ".claude");
      mkdirSync(claudeDir, { recursive: true });
      const at = new Date(`${day}T08:00:00Z`);
      writeFileSync(join(claudeDir, "CLAUDE.md"), content, "utf8");
      utimesSync(join(claudeDir, "CLAUDE.md"), at, at);
    };
    const layout1 =
      "<!-- agent-julia:persona-core:start -->\n# Persona\n<!-- agent-julia:persona-core:end -->\n";

    // A weeks-old layout-1 session behind an empty newest one is history.
    seed("local_old", layout1, "2026-08-20");
    seed("1a2b3c4d", "", "2026-10-01");
    let seen = byName(await runDoctor(cfg, targets), "paste seen");
    expect(seen.status).toBe("unknown");
    expect(seen.detail).toContain("2026-10-01");
    expect(seen.fix).toBeUndefined();

    // The newest session really carrying the old block is still worth a warning.
    seed("5e6f7a8b", layout1, "2026-10-02");
    seen = byName(await runDoctor(cfg, targets), "paste seen");
    expect(seen.status).toBe("warn");
    expect(seen.detail).toContain("2026-10-02");
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

describe("a persona block that quotes our own marker", () => {
  it("is reported current, the same way the boot refresh sees it", async () => {
    const { dir, targets } = sandbox();
    const memoryDir = join(dir, "mem");
    mkdirSync(memoryDir, { recursive: true });
    const cfg = ConfigSchema.parse({ memoryDir, git: false, surfaces: ["code"] });
    const paths = storePaths(memoryDir);
    await appendCorrection(paths, "Never paste <!-- agent-julia:persona-core:start --> into a reply.");

    await upsertManagedBlock(targets.claudeCodeMemory, STARTUP_BLOCK_ID, await buildInjectedCore(paths, cfg));

    const c = byName(await runDoctor(cfg, targets), "persona (code)");
    expect(c.status).toBe("ok");
  });
});

describe("a registration that can no longer start", () => {
  function setup() {
    const { dir, targets } = sandbox();
    const memoryDir = join(dir, "mem");
    mkdirSync(memoryDir, { recursive: true });
    const cfg = ConfigSchema.parse({ memoryDir, git: false, surfaces: ["code", "cowork"] });
    const register = (file: string, entry: unknown) =>
      writeFileSync(file, JSON.stringify({ mcpServers: { "agent-julia": entry } }), "utf8");
    return { dir, targets, cfg, register };
  }

  it("fails when the registered node binary is gone", async () => {
    // What `brew upgrade node` and the cleanup after it leave behind: the key is
    // still there, the Cellar directory it names is not.
    const { dir, targets, cfg, register } = setup();
    const script = join(dir, "index.js");
    writeFileSync(script, "", "utf8");
    const gone = join(dir, "Cellar", "node", "26.4.0", "bin", "node");
    register(targets.claudeCodeConfig, { command: gone, args: [script, "serve"] });
    register(targets.desktopConfig!, { command: gone, args: [script, "serve"] });

    const checks = await runDoctor(cfg, targets);
    for (const name of ["mcp (code)", "mcp (cowork)"]) {
      const c = byName(checks, name);
      expect(c.status).toBe("fail");
      expect(c.detail).toContain(gone);
      expect(c.fix).toContain("agent-julia sync");
    }
  });

  it("fails when the script the launcher runs is gone", async () => {
    const { dir, targets, cfg, register } = setup();
    const gone = join(dir, "moved-checkout", "dist", "index.js");
    register(targets.claudeCodeConfig, { command: process.execPath, args: [gone, "serve"] });

    const c = byName(await runDoctor(cfg, targets), "mcp (code)");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain(gone);
  });

  it("passes a launcher whose paths exist, and leaves PATH lookups alone", async () => {
    const { dir, targets, cfg, register } = setup();
    const script = join(dir, "index.js");
    writeFileSync(script, "", "utf8");
    register(targets.claudeCodeConfig, { command: process.execPath, args: [script, "serve"] });
    // npx is resolved on PATH by the client; doctor has no business guessing.
    register(targets.desktopConfig!, { command: "npx", args: ["-y", "agent-julia@latest", "serve"] });

    const checks = await runDoctor(cfg, targets);
    expect(byName(checks, "mcp (code)").status).toBe("ok");
    expect(byName(checks, "mcp (cowork)").status).toBe("ok");
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
