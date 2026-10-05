import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
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

// Bring the shipped skills into targetDir, touching only copies we own.
// targetDir is a parameter for testability; callers pass skillsTargetDir().
// sourceRoot likewise, so a test can ship a file and then stop shipping it.
//
// Every server boot runs this, and there is one server per Claude session. It
// used to copy the whole tree each time: dozens of rewrites of files Claude
// Code and Cowork were reading, none of them atomic, while a file dropped from
// the package stayed in the installed copy forever. Now a file is written only
// when its bytes differ, through a temp file and a rename, and a file the
// package no longer ships is removed.
export async function installSkills(targetDir: string, sourceRoot = SHIPPED_SKILLS_DIR): Promise<SkillStep[]> {
  const steps: SkillStep[] = [];
  for (const skill of SHIPPED_SKILLS) {
    const source = join(sourceRoot, skill);
    const target = join(targetDir, skill);
    if (!existsSync(source)) {
      steps.push({ skill, status: "skipped", detail: `packaged skill missing: ${source}` });
      continue;
    }
    if (existsSync(target) && !(await ownsInstalledCopy(target))) {
      steps.push({ skill, status: "skipped", detail: `${target} exists and isn't managed by agent-julia` });
      continue;
    }
    const changed = await syncTree(source, target);
    steps.push({ skill, status: "done", detail: changed > 0 ? `${target} (${changed} file(s) updated)` : target });
  }
  return steps;
}

const TMP_SUFFIX = ".agent-julia-tmp";
// A temp file younger than this may be another installer's write in flight
// (`sync` run by hand while a server boots); removing it would fail that
// rename. Older ones are leftovers from a crash.
const TMP_GRACE_MS = 60_000;

// Make target hold exactly what source holds. Only ever called on a directory
// that is ours: either absent, or carrying the ownership marker.
async function syncTree(source: string, target: string): Promise<number> {
  const shipped = await listFiles(source);
  // The manifest first. It carries the ownership marker, so a run that dies
  // halfway leaves a copy the next boot still recognises as its own and
  // finishes, not one it mistakes for the user's and leaves alone for good.
  shipped.sort((a, b) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b)));

  let changed = 0;
  for (const rel of shipped) {
    const from = join(source, rel);
    const to = join(target, rel);
    const want = await readFile(from);
    const have = await readFile(to).catch(() => null);
    if (have && have.equals(want)) continue;
    await mkdir(dirname(to), { recursive: true });
    const tmp = `${to}.${process.pid}.${randomUUID().slice(0, 8)}${TMP_SUFFIX}`;
    try {
      await writeFile(tmp, want);
      await rename(tmp, to);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    changed++;
  }

  const keep = new Set(shipped);
  changed += await prune(target, "", keep);
  return changed;
}

// Remove what the package no longer ships. Directories go too, once nothing
// shipped lives under them.
async function prune(root: string, rel: string, keep: Set<string>): Promise<number> {
  let removed = 0;
  for (const entry of await readdir(join(root, rel), { withFileTypes: true }).catch(() => [])) {
    const childRel = rel ? join(rel, entry.name) : entry.name;
    const full = join(root, childRel);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      if ([...keep].some((k) => k.startsWith(childRel + sep))) {
        removed += await prune(root, childRel, keep);
      } else {
        await rm(full, { recursive: true, force: true });
        removed++;
      }
      continue;
    }
    if (keep.has(childRel)) continue;
    if (entry.name.endsWith(TMP_SUFFIX)) {
      const st = await stat(full).catch(() => null);
      if (st && Date.now() - st.mtimeMs < TMP_GRACE_MS) continue;
    }
    await rm(full, { force: true });
    removed++;
  }
  return removed;
}

// Every file under dir, as paths relative to it. Symlinks are not followed:
// the package ships plain files.
async function listFiles(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
    const childRel = rel ? join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(dir, childRel)));
    else if (entry.isFile()) out.push(childRel);
  }
  return out;
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
