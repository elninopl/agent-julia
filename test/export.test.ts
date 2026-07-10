import { mkdirSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportPersona, exportText, refreshExports, removeExport, resolveExportTarget } from "../src/export/export.js";
import { appendCorrection } from "../src/persona/corrections.js";
import { storePaths } from "../src/store/paths.js";
import { ConfigSchema } from "../src/config/schema.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "aj-export-"));
  const config = ConfigSchema.parse({ memoryDir: join(dir, "mem"), git: false, name: "Julia" });
  mkdirSync(config.memoryDir, { recursive: true });
  return { dir, config };
}

describe("persona export", () => {
  it("resolves aliases and arbitrary paths", () => {
    expect(resolveExportTarget("codex")).toContain(join(".codex", "AGENTS.md"));
    expect(resolveExportTarget("/tmp/AGENTS.md")).toBe("/tmp/AGENTS.md");
  });

  it("writes the persona without the memory instruction", async () => {
    const { dir, config } = fresh();
    const target = join(dir, "AGENTS.md");
    await exportPersona(config, target);
    const content = readFileSync(target, "utf8");
    expect(content).toContain("You are Julia");
    expect(content).toContain("persona-export:start");
    // The Claude-specific memory instruction must NOT be exported.
    expect(content).not.toContain("Memory (agent-julia)");
  });

  it("boot refresh updates recorded exports when the persona changes", async () => {
    const { dir, config } = fresh();
    const target = join(dir, "AGENTS.md");
    const path = await exportPersona(config, target);
    const cfg = { ...config, exports: [path] };

    // Unchanged persona: no rewrite.
    expect(await refreshExports(cfg)).toBe(0);

    // A new correction changes the core — refresh must propagate it.
    await appendCorrection(storePaths(config.memoryDir), "never use semicolons in prose");
    expect(await refreshExports(cfg)).toBe(1);
    expect(readFileSync(target, "utf8")).toContain("never use semicolons in prose");

    // Removing the block by hand means we stop touching the file.
    const { removed } = await removeExport(cfg, target);
    expect(removed).toBe(true);
    expect(await refreshExports(cfg)).toBe(0);
    expect(existsSync(target)).toBe(true);
  });

  it("exportText carries corrections and privacy rail", async () => {
    const { config } = fresh();
    await appendCorrection(storePaths(config.memoryDir), "commit to opinions");
    const text = await exportText(config);
    expect(text).toContain("commit to opinions");
    expect(text).toContain("## Never store");
  });
});
