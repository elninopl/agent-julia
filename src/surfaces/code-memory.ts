import { Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { copyFile, readdir, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Config } from "../config/schema.js";
import { Indexer } from "../index/indexer.js";
import { StorePaths, pageId } from "../store/paths.js";
import { parseFrontmatter, stringifyFrontmatter } from "../store/frontmatter.js";
import { readPage, writeFileAtomic } from "../store/markdown.js";
import { endMarker, removeManagedBlock, startMarker, upsertManagedBlock } from "../managed/block.js";
import { ingest } from "../store/ingest.js";
import {
  PageSource,
  ROUTING_RULE,
  detectSources,
  loadRoutes,
  mergeSources,
  normalizeDir,
  renderSources,
} from "../store/sources.js";
import { warn } from "../util/log.js";

// CLIENT-DEPENDENT, undocumented, may break without notice.
//
// Claude Code keeps a memory of its own: one directory per working directory
// under ~/.claude/projects/<slug>/memory, an index (MEMORY.md) the client puts
// into the prompt of every session started there, and one file per fact whose
// `description` is the key it recalls on. None of that is documented, so every
// path this package knows about lives in this file, and every failure here is
// "no signal" rather than a failed step.
//
// It is a second memory competing with this one: same job, same model deciding
// between them, and a fact written there reaches Claude Code in that directory
// and nothing else. Two modes settle it (config.codeMemory):
//
//   pointer — own a marked block in MEMORY.md that sends the client here.
//   absorb  — additionally move what was written there anyway into the store,
//             leaving behind a pointer to the page that now holds it.
//
// A directory is never created: adoption only ever touches what the client made
// for itself.
export const CODE_MEMORY_BLOCK_ID = "code-memory";

// The comment that marks a file this package has already moved. Distinctive on
// purpose: a plain sentence would match a memory that happens to talk about
// agent-julia, and re-absorbing a pointer would fill the page with its own
// footprints.
const ABSORBED_MARK = "<!-- agent-julia:absorbed";

const MAX_PROJECTS = 200;
// A directory holding more than this is not a handful of stray notes, it is a
// knowledge base someone chose to keep there. Absorbing it silently would fold
// a deliberate split into the store as one enormous page; report it and let the
// user say so explicitly (`sync --absorb-all`).
const ABSORB_LIMIT = 25;
// A memory file is a fact someone wrote down. Anything past this is not that,
// and the store is not a place to park it.
const MAX_FILE_BYTES = 64_000;

export function codeMemoryRoot(): string {
  return join(homedir(), ".claude", "projects");
}

export interface CodeMemoryProject {
  /** Directory name under ~/.claude/projects — the slugified working directory. */
  slug: string;
  dir: string;
  indexPath: string;
  /** Working directory the slug stands for, when it can still be resolved. */
  workingDir: string | null;
  /** Short name used for the page id: the working directory's basename. */
  name: string;
}

export async function findCodeMemoryProjects(root = codeMemoryRoot()): Promise<CodeMemoryProject[]> {
  const out: CodeMemoryProject[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.slice(0, MAX_PROJECTS)) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name, "memory");
    if (!existsSync(dir)) continue;
    const workingDir = decodeWorkingDir(entry.name);
    out.push({
      slug: entry.name,
      dir,
      indexPath: join(dir, "MEMORY.md"),
      workingDir,
      name: workingDir ? basename(workingDir) : entry.name.replace(/^-+/, ""),
    });
  }
  return out;
}

// The slug is the working directory with every character that is not an ASCII
// letter or digit replaced by a dash — separators, but also "_", ".", spaces
// and "ó". That is not reversible on its own: "-Users-me-Sites-agent-julia"
// could be .../agent/julia, .../agent-julia or .../agent_julia. Resolve it
// against the filesystem instead: at each level, find the entries whose own
// slug is a prefix of what is left, longest first, and backtrack when a branch
// dead-ends. A directory that has since been moved or deleted yields null.
export function decodeWorkingDir(slug: string): string | null {
  // Windows: "C:\Users\me" becomes "C--Users-me".
  const drive = process.platform === "win32" ? /^([A-Za-z])--(.*)$/.exec(slug) : null;
  const [root, rest] = drive ? [`${drive[1]}:\\`, drive[2]!] : ["/", slug.replace(/^-/, "")];
  return rest ? resolveSlug(root, rest) : null;
}

function slugSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "-");
}

function resolveSlug(base: string, rest: string): string | null {
  let entries: Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return null;
  }
  const matches = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => ({ name: entry.name, slug: slugSegment(entry.name) }))
    .filter(({ slug }) => rest === slug || rest.startsWith(`${slug}-`))
    .sort((a, b) => b.slug.length - a.slug.length);
  for (const { name, slug } of matches) {
    const path = join(base, name);
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) continue;
    if (rest === slug) return path;
    const found = resolveSlug(path, rest.slice(slug.length + 1));
    if (found) return found;
  }
  return null;
}

// Where a project's absorbed facts land. Prefixed rather than named after the
// project: a store commonly already has a curated page called `prive` or
// `agent-julia`, and appending machine-captured notes into it would bury the
// page the user actually writes.
export function pageForProject(project: CodeMemoryProject): string {
  return pageId(`code-memory-${project.name}`);
}

export interface PointerContext {
  /** Page holding what was absorbed out of this directory. */
  page?: string | null;
  /** Page in the store that is about this project. */
  projectPage?: string | null;
  /** Where this project's own documentation lives. */
  sources?: PageSource[];
  workingDir?: string | null;
  /**
   * False for a directory whose backlog is past the limit: absorb never runs
   * there until the user asks for it, and a block promising otherwise would be
   * a claim about behaviour that is not happening.
   */
  absorbing?: boolean;
}

export function pointerBody(config: Config, ctx: PointerContext = {}): string {
  const lines = [
    "This project's durable memory lives in agent-julia, not in this directory.",
    "",
    "- Search first: before answering anything that depends on what you know about this user, their projects or past decisions, call agent-julia's `search` / `read`. What is here is a local cache at best.",
    "- Save through `ingest`, not by writing a file here. A page in agent-julia is reachable from Claude Code, Claude Desktop and Cowork; a file here is reachable only from this directory.",
    "- When the user corrects how you write or speak, call `correct_voice` before you reply.",
  ];
  if (config.codeMemory === "absorb" && ctx.absorbing !== false) {
    lines.push(
      "- A file written here anyway is moved into agent-julia on the next start and replaced by a pointer to the page that holds it.",
    );
  }
  if (ctx.projectPage) lines.push(`- This project's page in agent-julia is \`${ctx.projectPage}\`.`);
  if (ctx.page) lines.push(`- This project's captured notes are on page \`${ctx.page}\`.`);

  // The repo's own documentation. Naming it here is the whole point of the
  // block on this surface: the model is standing inside the repo, and the
  // question "where does this belong" has two answers that must not be mixed.
  const sources = ctx.sources ?? [];
  if (sources.length > 0) {
    lines.push(
      "",
      "This project documents itself, and that documentation is not in agent-julia:",
      ...renderSources(sources, ctx.workingDir ?? undefined),
      "",
      ROUTING_RULE,
    );
  }
  return lines.join("\n");
}

export interface AdoptionReport {
  projects: number;
  /** Index files whose pointer block was written or brought up to date. */
  pointers: number;
  /** Memory files moved into the store. */
  absorbed: number;
  /** Memory files still holding content of their own (absorb is off). */
  pending: number;
  /** Directories left alone because their backlog is past ABSORB_LIMIT. */
  overflow: number;
  failed: number;
}

export const ABSORB_BATCH_LIMIT = ABSORB_LIMIT;

export async function adoptCodeMemory(
  paths: StorePaths,
  indexer: Indexer,
  config: Config,
  root = codeMemoryRoot(),
  force = false,
): Promise<AdoptionReport> {
  const report: AdoptionReport = { projects: 0, pointers: 0, absorbed: 0, pending: 0, overflow: 0, failed: 0 };
  if (config.codeMemory === "off") return report;

  // Once per run, not once per project: matching a directory against every page
  // separately would read the whole store five times on a boot.
  const routes = await loadRoutes(paths);
  for (const project of await findCodeMemoryProjects(root)) {
    report.projects++;
    try {
      const loose = await looseFiles(project);
      const tooMany = loose.length > ABSORB_LIMIT && !force;
      let absorbing = config.codeMemory === "absorb";
      if (config.codeMemory === "absorb" && !tooMany) {
        for (const file of loose) {
          if (await absorbFile(paths, indexer, config, project, file)) report.absorbed++;
          else report.pending++;
        }
      } else {
        report.pending += loose.length;
        if (tooMany && config.codeMemory === "absorb") {
          report.overflow++;
          absorbing = false;
          warn(
            `code memory: ${project.name} keeps ${loose.length} facts of its own, past the ${ABSORB_LIMIT} this ` +
              "moves unasked. Run `agent-julia sync --absorb-all` if you mean to bring them all in.",
          );
        }
      }

      // Per project, and after absorbing: a cumulative counter would have let
      // one project's page be announced in another project's index.
      const page = (await readPage(paths, pageForProject(project))) ? pageForProject(project) : null;
      const route = project.workingDir ? routes.get(await normalizeDir(project.workingDir)) : undefined;
      const detected = project.workingDir ? await detectSources(project.workingDir) : [];
      const body = pointerBody(config, {
        page,
        projectPage: route?.page ?? null,
        sources: mergeSources(route?.sources ?? [], detected),
        workingDir: project.workingDir,
        absorbing,
      });
      if (await upsertIfChanged(project.indexPath, body)) report.pointers++;
    } catch (err) {
      // One unwritable directory must not stop the rest, and must never take a
      // booting server down with it.
      report.failed++;
      warn(`code memory: ${project.slug} left alone (${(err as Error).message})`);
    }
  }
  return report;
}

// Non-mutating view of the same directories, for doctor.
export async function codeMemoryStatus(
  root = codeMemoryRoot(),
): Promise<{ projects: number; adopted: number; loose: number }> {
  let adopted = 0;
  let loose = 0;
  const projects = await findCodeMemoryProjects(root);
  for (const project of projects) {
    const content = await readFile(project.indexPath, "utf8").catch(() => "");
    if (content.includes(startMarker(CODE_MEMORY_BLOCK_ID))) adopted++;
    loose += (await looseFiles(project)).length;
  }
  return { projects: projects.length, adopted, loose };
}

// Give the directories back: the pointer block goes, and every file this package
// replaced with a pointer is restored from the backup it took first.
export async function releaseCodeMemory(root = codeMemoryRoot()): Promise<{ pointers: number; restored: number }> {
  let pointers = 0;
  let restored = 0;
  for (const project of await findCodeMemoryProjects(root)) {
    if (await removeManagedBlock(project.indexPath, CODE_MEMORY_BLOCK_ID).catch(() => false)) pointers++;
    for (const name of await readdir(project.dir).catch(() => [])) {
      if (!name.endsWith(".md")) continue;
      const file = join(project.dir, name);
      const backup = `${file}.agent-julia-bak`;
      if (!existsSync(backup)) continue;
      const content = await readFile(file, "utf8").catch(() => "");
      if (!content.includes(ABSORBED_MARK)) continue;
      await copyFile(backup, file);
      await rm(backup, { force: true }).catch(() => undefined);
      restored++;
    }
  }
  return { pointers, restored };
}

// Files the client wrote and this package has not already moved. MEMORY.md is
// the index, not a fact, and it is the one file here with an owner.
async function looseFiles(project: CodeMemoryProject): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(project.dir).catch(() => [])) {
    if (!name.endsWith(".md") || name === "MEMORY.md" || name.startsWith(".")) continue;
    const file = join(project.dir, name);
    const st = await stat(file).catch(() => null);
    if (!st?.isFile() || st.size > MAX_FILE_BYTES) continue;
    const content = await readFile(file, "utf8").catch(() => "");
    if (content.includes(ABSORBED_MARK)) continue;
    out.push(file);
  }
  return out.sort();
}

async function absorbFile(
  paths: StorePaths,
  indexer: Indexer,
  config: Config,
  project: CodeMemoryProject,
  file: string,
): Promise<boolean> {
  const raw = await readFile(file, "utf8");
  let parsed: { data: Record<string, unknown>; content: string };
  try {
    parsed = parseFrontmatter(raw);
  } catch {
    // A file whose front matter will not parse is still someone's note: keep it
    // whole rather than dropping it, and let the body carry it.
    parsed = { data: {}, content: raw };
  }
  const body = parsed.content.trim();
  if (body.length === 0) return false;

  const page = pageForProject(project);
  const name = String(parsed.data.name ?? basename(file, ".md"));
  const description = typeof parsed.data.description === "string" ? parsed.data.description : "";
  // The provenance line doubles as the dedupe key: an absorb that succeeded and
  // then failed to leave its pointer behind must not append the same fact again
  // on the next boot.
  const digest = createHash("sha1").update(body).digest("hex").slice(0, 8);
  const existing = await readPage(paths, page);
  if (existing?.body.includes(digest)) {
    await leavePointer(file, parsed.data, page, name);
    return true;
  }

  const section = [
    `## ${name}`,
    "",
    `_Captured by Claude Code in ${project.workingDir ?? project.slug} · ${basename(file)} · ${digest}_`,
    ...(description ? ["", `**${description}**`] : []),
    "",
    body,
  ].join("\n");

  await ingest(paths, indexer, page, section, {
    mode: "append",
    title: `Claude Code memory: ${project.name}`,
    git: config.git,
    autoPush: config.gitAutoPush,
  });
  await leavePointer(file, parsed.data, page, name);
  return true;
}

// Replace the file with a pointer, keeping the front matter that makes the
// client recall it: the description is the key it ranks on, so a stub that drops
// it would quietly remove the fact from recall instead of redirecting it.
async function leavePointer(
  file: string,
  data: Record<string, unknown>,
  page: string,
  name: string,
): Promise<void> {
  const backup = `${file}.agent-julia-bak`;
  if (!existsSync(backup)) await copyFile(file, backup);
  const body = [
    `${ABSORBED_MARK} page=${page} -->`,
    "",
    `This fact now lives in agent-julia, on page \`${page}\` (section "${name}").`,
    "Call agent-julia's `read` with that id, or `search`, for the current version.",
    "Don't edit this file: write through `ingest` so every surface sees the change.",
  ].join("\n");
  await writeFileAtomic(file, `${stringifyFrontmatter(body, data).trimEnd()}\n`);
}

// Rewrite the pointer block only when it would change. A dozen servers boot at
// once on a busy machine, and an unconditional write means a dozen rewrites of
// a file the client is reading.
async function upsertIfChanged(indexPath: string, body: string): Promise<boolean> {
  const block = `${startMarker(CODE_MEMORY_BLOCK_ID)}\n${body.trim()}\n${endMarker(CODE_MEMORY_BLOCK_ID)}`;
  const current = await readFile(indexPath, "utf8").catch(() => "");
  if (current.includes(block)) return false;
  await upsertManagedBlock(indexPath, CODE_MEMORY_BLOCK_ID, body);
  return true;
}
