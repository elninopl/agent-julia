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
    expect(installed[0].status).toBe("skipped");
    expect(readFileSync(join(dir, "brainstorm", "SKILL.md"), "utf8")).toContain("my own skill");

    const removed = await uninstallSkills(dir);
    expect(removed[0].status).toBe("skipped");
    expect(existsSync(join(dir, "brainstorm", "SKILL.md"))).toBe(true);
  });
});
