import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectLegacyPaste, LegacyPasteTargets } from "../src/server.js";
import { ConfigSchema } from "../src/config/schema.js";

function sandbox(): { dir: string; t: LegacyPasteTargets } {
  const dir = mkdtempSync(join(tmpdir(), "aj-legacy-"));
  return {
    dir,
    t: {
      marker: join(dir, "cowork-paste.json"),
      legacyMarker: join(dir, "cowork-pasted.sha1"),
      surfaces: join(dir, "surfaces.json"),
      sessionRoots: [join(dir, "sessions")],
    },
  };
}

function seed(t: LegacyPasteTargets, name: string, layout: 1 | 2, day: string): void {
  const claudeDir = join(t.sessionRoots[0]!, "acct", "org", name, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const head = layout === 2 ? "agent-julia paste, layout 2" : "# Persona";
  const file = join(claudeDir, "CLAUDE.md");
  writeFileSync(
    file,
    `<!-- agent-julia:persona-core:start -->\n${head}\n<!-- agent-julia:persona-core:end -->\n`,
    "utf8",
  );
  const at = new Date(`${day}T08:00:00Z`);
  utimesSync(file, at, at);
}

describe("looking for an old layout-1 paste at boot", () => {
  it("looks once, and remembers the answer when it writes no marker", async () => {
    // The old sha1 marker on disk and a layout-2 session: nothing to migrate,
    // and nothing used to be written, so every boot walked the tree again.
    const { dir, t } = sandbox();
    const config = ConfigSchema.parse({ memoryDir: join(dir, "mem"), git: false, surfaces: ["cowork"] });
    writeFileSync(t.legacyMarker, "0".repeat(40) + "\n", "utf8");
    seed(t, "local_0001", 2, "2026-09-20");

    await detectLegacyPaste(config, t);
    expect(existsSync(t.marker)).toBe(false);
    const state = JSON.parse(readFileSync(t.surfaces, "utf8")) as { legacyPasteCheck?: { seen: string } };
    expect(state.legacyPasteCheck?.seen).toBe("layout 2");

    // Had the next boot probed again, this newer layout-1 session would have
    // produced a marker.
    seed(t, "1a2b3c4d", 1, "2026-10-01");
    await detectLegacyPaste(config, t);
    expect(existsSync(t.marker)).toBe(false);
  });

  it("still records a layout-1 paste it finds", async () => {
    const { dir, t } = sandbox();
    const config = ConfigSchema.parse({ memoryDir: join(dir, "mem"), git: false, surfaces: ["cowork"] });
    seed(t, "local_0001", 1, "2026-09-20");

    await detectLegacyPaste(config, t);
    const marker = JSON.parse(readFileSync(t.marker, "utf8")) as { previousLayout?: number };
    expect(marker.previousLayout).toBe(1);
  });

  it("remembers that it found nothing, too", async () => {
    const { dir, t } = sandbox();
    const config = ConfigSchema.parse({ memoryDir: join(dir, "mem"), git: false, surfaces: ["cowork"] });
    await detectLegacyPaste(config, t);
    const state = JSON.parse(readFileSync(t.surfaces, "utf8")) as { legacyPasteCheck?: { seen: string } };
    expect(state.legacyPasteCheck?.seen).toBe("no block");
    expect(existsSync(t.marker)).toBe(false);
  });

  it("leaves a machine without a Desktop surface alone", async () => {
    const { dir, t } = sandbox();
    const config = ConfigSchema.parse({ memoryDir: join(dir, "mem"), git: false, surfaces: ["code"] });
    await detectLegacyPaste(config, t);
    expect(existsSync(t.surfaces)).toBe(false);
  });
});
