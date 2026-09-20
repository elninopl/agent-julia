import { existsSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PageFrontmatter, listPageIds, readPage } from "./markdown.js";
import { StorePaths } from "./paths.js";

// A project usually documents itself, and that documentation is not — and
// should not become — a copy inside this store. prive keeps 587 markdown files
// under _doc/; acme keeps its own tree and serves the same knowledge through an
// MCP server. Absorbing either would bury a split the user made on purpose and
// go stale the same week.
//
// So a page can say where the rest of what it is about actually lives, and
// agent-julia routes there instead of pretending to hold it:
//
//   project: ~/Sites/prive
//   sources:
//     - kind: dir
//       at: _doc
//       about: product and technical documentation
//     - kind: mcp
//       at: acme
//       how: docs_search, docs_read
//       about: company documentation
//
// Both keys are optional and free-form on purpose: this describes someone
// else's setup, and a shape too strict to hold it would just be ignored.
export type SourceKind = "dir" | "file" | "mcp" | "url";

export interface PageSource {
  kind: SourceKind;
  /** A path (relative to the project, or absolute), a server name, or a URL. */
  at: string;
  /** What it covers, in the user's own words. */
  about?: string;
  /** How to reach it, where naming the place is not enough (MCP tool names). */
  how?: string;
}

export interface ProjectRoute {
  /** Page that declared the project, when one did. */
  page?: string;
  sources: PageSource[];
}

const KINDS: SourceKind[] = ["dir", "file", "mcp", "url"];

export function expandHome(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

// Normalised enough to compare two spellings of the same directory. realpath
// where it resolves, because /var and /private/var are the same place and a
// user's ~/Sites may well be a symlink.
export async function normalizeDir(path: string): Promise<string> {
  const expanded = resolve(expandHome(path));
  return (await realpath(expanded).catch(() => expanded)).replace(/\/+$/, "");
}

export function readProjects(fm: PageFrontmatter): string[] {
  const raw = fm.project ?? fm.projects;
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  return [];
}

// Tolerant on purpose. The object form is what tools write; the string form
// ("dir:_doc — the product docs") is what a person types, and refusing it would
// make the feature silently do nothing for exactly the people who reached for it.
export function readSources(fm: PageFrontmatter): PageSource[] {
  const raw = fm.sources;
  if (!Array.isArray(raw)) return [];
  const out: PageSource[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const parsed = parseSourceString(entry);
      if (parsed) out.push(parsed);
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const at = typeof rec.at === "string" ? rec.at.trim() : typeof rec.path === "string" ? rec.path.trim() : "";
    if (!at) continue;
    const kind = KINDS.includes(rec.kind as SourceKind) ? (rec.kind as SourceKind) : inferKind(at);
    out.push({
      kind,
      at,
      ...(typeof rec.about === "string" ? { about: rec.about.trim() } : {}),
      ...(typeof rec.how === "string" ? { how: rec.how.trim() } : {}),
    });
  }
  return out;
}

function parseSourceString(entry: string): PageSource | null {
  const [head, ...rest] = entry.split(/\s+[—-]\s+/);
  const about = rest.join(" - ").trim();
  const text = (head ?? "").trim();
  if (!text) return null;
  const match = /^(dir|file|mcp|url):\s*(.+)$/i.exec(text);
  const at = (match?.[2] ?? text).trim();
  const kind = match ? (match[1]!.toLowerCase() as SourceKind) : inferKind(at);
  return { kind, at, ...(about ? { about } : {}) };
}

function inferKind(at: string): SourceKind {
  if (/^https?:\/\//i.test(at)) return "url";
  if (at.endsWith("/")) return "dir";
  return /\.[a-z0-9]{1,5}$/i.test(at) ? "file" : "dir";
}

// What a project documents about itself, without anyone declaring it. Only
// what can be told from the filesystem: an MCP server serving documentation
// cannot be recognised from here and has to be written down.
const DOC_DIRS = ["_doc", "docs", "documentation", "_docs"];
const DOC_FILES = ["CLAUDE.md", "AGENTS.md"];

export async function detectSources(workingDir: string): Promise<PageSource[]> {
  const out: PageSource[] = [];
  for (const name of DOC_DIRS) {
    const dir = join(workingDir, name);
    if (!existsSync(dir)) continue;
    const count = await countMarkdown(dir);
    out.push({
      kind: "dir",
      at: name,
      about: count > 0 ? `${count} markdown file(s) of the project's own documentation` : "the project's own documentation",
    });
  }
  for (const name of DOC_FILES) {
    if (existsSync(join(workingDir, name))) {
      out.push({ kind: "file", at: name, about: "the repo's own instructions" });
    }
  }
  return out;
}

async function countMarkdown(dir: string, depth = 0): Promise<number> {
  if (depth > 4) return 0;
  let count = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory() && !entry.isSymbolicLink()) count += await countMarkdown(join(dir, entry.name), depth + 1);
    else if (entry.isFile() && entry.name.endsWith(".md")) count++;
  }
  return count;
}

// Every declared route in the store, keyed by normalised working directory.
// Built once per run: matching a directory against 200 pages one at a time
// would read the whole store for every project on every server start.
export async function loadRoutes(paths: StorePaths): Promise<Map<string, ProjectRoute>> {
  const routes = new Map<string, ProjectRoute>();
  for (const id of await listPageIds(paths)) {
    const page = await readPage(paths, id).catch(() => null);
    if (!page) continue;
    const projects = readProjects(page.frontmatter);
    if (projects.length === 0) continue;
    const sources = readSources(page.frontmatter);
    for (const project of projects) {
      routes.set(await normalizeDir(project), { page: id, sources });
    }
  }
  return routes;
}

// Declared first, detected after, one entry per place. A declaration says what
// the directory listing cannot — what a source covers and how to reach it — so
// it must not be pushed aside by a guess about the same path.
export function mergeSources(declared: PageSource[], detected: PageSource[]): PageSource[] {
  const seen = new Set(declared.map((s) => `${s.kind}:${s.at.replace(/\/+$/, "")}`));
  return [...declared, ...detected.filter((s) => !seen.has(`${s.kind}:${s.at.replace(/\/+$/, "")}`))];
}

// One line per source, for a reader who has to decide where to look next.
export function renderSources(sources: PageSource[], workingDir?: string): string[] {
  return sources.map((s) => {
    const about = s.about ? ` — ${s.about}` : "";
    switch (s.kind) {
      case "mcp":
        return `- the \`${s.at}\` MCP server${s.how ? ` (${s.how})` : ""}${about}`;
      case "url":
        return `- ${s.at}${about}`;
      default: {
        const where = workingDir && !isAbsolute(expandHome(s.at)) ? join(workingDir, s.at) : expandHome(s.at);
        return `- \`${where}${s.kind === "dir" ? "/" : ""}\`${about}`;
      }
    }
  });
}

// The routing rule itself. Without this line a list of places is just a list;
// with it, the reader knows which question goes where.
export const ROUTING_RULE =
  "Ask agent-julia about the user, their projects and past decisions; read the documentation above for how this one works. " +
  "Don't copy that documentation into agent-julia — route to it.";

// The routing block for one page, from what it declares plus what its project
// directory shows. Null when the page is about nothing that lives elsewhere,
// so a page with no sources reads exactly as it did before.
export async function routingNoteFor(fm: PageFrontmatter): Promise<string | null> {
  const projects = readProjects(fm);
  const declared = readSources(fm);
  const workingDir = projects[0] ? expandHome(projects[0]) : undefined;
  const detected = workingDir && existsSync(workingDir) ? await detectSources(workingDir) : [];
  const sources = mergeSources(declared, detected);
  if (sources.length === 0) return null;
  return [
    "Documentation this store does not hold:",
    ...renderSources(sources, workingDir),
    "",
    ROUTING_RULE,
  ].join("\n");
}
