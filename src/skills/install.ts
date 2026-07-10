import { existsSync } from "node:fs";
import { cp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Shipped skills live next to the compiled module (assets/ is copied into
// dist/skills/ by the build step), so this resolves in dev and installed alike.
const SHIPPED_SKILLS_DIR = join(here, "assets");

export function shippedSkillsDir(): string {
  return SHIPPED_SKILLS_DIR;
}

// Skills agent-julia ships. Each is a directory with a SKILL.md inside.
export const SHIPPED_SKILLS = ["brainstorm"] as const;

// The marker that tells us a skill directory is ours to manage. Installed
// copies without it (a user's own skill under the same name) are never touched.
const OWNERSHIP_MARKER = "author: agent-julia";

// ~/.claude/skills is read by both Claude Code and Cowork (Claude Desktop),
// so one install location covers every supported surface.
export function skillsTargetDir(): string {
  return join(homedir(), ".claude", "skills");
}

export interface SkillStep {
  skill: string;
  status: "done" | "skipped";
  detail: string;
}

async function ownsInstalledCopy(dir: string): Promise<boolean> {
  const manifest = join(dir, "SKILL.md");
  if (!existsSync(manifest)) return false;
  try {
    return (await readFile(manifest, "utf8")).includes(OWNERSHIP_MARKER);
  } catch {
    return false;
  }
}

// Copy the shipped skills into targetDir, overwriting only copies we own.
// targetDir is a parameter for testability; callers pass skillsTargetDir().
export async function installSkills(targetDir: string): Promise<SkillStep[]> {
  const steps: SkillStep[] = [];
  for (const skill of SHIPPED_SKILLS) {
    const source = join(SHIPPED_SKILLS_DIR, skill);
    const target = join(targetDir, skill);
    if (!existsSync(source)) {
      steps.push({ skill, status: "skipped", detail: `packaged skill missing: ${source}` });
      continue;
    }
    if (existsSync(target) && !(await ownsInstalledCopy(target))) {
      steps.push({ skill, status: "skipped", detail: `${target} exists and isn't managed by agent-julia` });
      continue;
    }
    await cp(source, target, { recursive: true });
    steps.push({ skill, status: "done", detail: target });
  }
  return steps;
}

// Remove installed skills, but only the copies we own.
export async function uninstallSkills(targetDir: string): Promise<SkillStep[]> {
  const steps: SkillStep[] = [];
  for (const skill of SHIPPED_SKILLS) {
    const target = join(targetDir, skill);
    if (!existsSync(target)) {
      steps.push({ skill, status: "skipped", detail: `not installed: ${target}` });
      continue;
    }
    if (!(await ownsInstalledCopy(target))) {
      steps.push({ skill, status: "skipped", detail: `${target} isn't managed by agent-julia, leaving it` });
      continue;
    }
    await rm(target, { recursive: true });
    steps.push({ skill, status: "done", detail: target });
  }
  return steps;
}
