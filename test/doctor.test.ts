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
      pasteMarker: join(dir, "pasted.sha1"),
      skillsDir: join(dir, "skills"),
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
    expect(byName(checks, "persona (cowork)").status).toBe("warn");
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
    // The index db legitimately doesn't exist before the first server start.
    expect(byName(checks, "index").status).toBe("warn");
    expect(checks.filter((c) => c.name !== "index").every((c) => c.status === "ok")).toBe(true);
  });

  it("detects Cowork drift when the core changes after the last paste", async () => {
    const { dir, targets } = sandbox();
    const memoryDir = join(dir, "mem");
    mkdirSync(memoryDir, { recursive: true });
    const cfg = ConfigSchema.parse({ memoryDir, git: false, surfaces: ["cowork"] });

    writeFileSync(targets.desktopConfig!, JSON.stringify({ mcpServers: { "agent-julia": {} } }), "utf8");
    writeFileSync(targets.pasteMarker, coreHash("an older core") + "\n", "utf8");
    await installSkills(targets.skillsDir);

    const checks = await runDoctor(cfg, targets);
    const drift = byName(checks, "persona (cowork)");
    expect(drift.status).toBe("warn");
    expect(drift.detail).toContain("drifted");
  });
});
