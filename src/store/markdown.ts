import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ParsedFrontmatter, parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";
import { warn } from "../util/log.js";
import { StorePaths, pageFilePath, pageId } from "./paths.js";
import { detectLanguage } from "./lang.js";

export interface PageFrontmatter {
  title?: string;
  status?: string;
  updated?: string; // absolute date, ISO (YYYY-MM-DD)
  lang?: string; // auto-detected output language (short code)
  tags?: string[];
  [k: string]: unknown;
}

export interface Page {
  // Set when the front matter could not be read. The page is still returned in
  // full; this says why its title and status are missing.
  frontmatterError?: string;
  id: string;
  path: string;
  frontmatter: PageFrontmatter;
  body: string;
}

export interface PageSummary {
  id: string;
  title: string;
  status?: string;
  updated?: string;
}

const LINK_RE = /\[\[([^\]]+)\]\]/g;

export function todayISO(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// Extract [[wiki-style]] cross-links from a body, normalized to page ids.
export function extractLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(LINK_RE)) {
    if (m[1]) out.add(pageId(m[1].split("|")[0]!.trim()));
  }
  return [...out];
}

// Pages related to `page` through wiki-links: what it links to (forward) and
// what links to it (back). Backlinks need a scan of every page body — fine at
// personal-knowledge-base scale; revisit if stores grow past a few thousand.
export async function relatedPages(
  paths: StorePaths,
  page: string,
): Promise<{ links: string[]; backlinks: string[] }> {
  const id = pageId(page);
  const self = await readPage(paths, id);
  const links = self ? extractLinks(self.body) : [];
  const backlinks: string[] = [];
  for (const other of await listPageIds(paths)) {
    if (other === id) continue;
    const p2 = await readPage(paths, other);
    if (p2 && extractLinks(p2.body).includes(id)) backlinks.push(other);
  }
  return { links, backlinks };
}

// Retire a page: move it out of the active KB into archive/ (kept, versioned,
// out of the index and catalog). The digest's "archive this" action.
export async function archivePage(paths: StorePaths, page: string): Promise<string | null> {
  const id = pageId(page);
  const from = pageFilePath(paths.root, id);
  if (!existsSync(from)) return null;
  await mkdir(paths.archiveDir, { recursive: true });

  // Never land on an existing name. Archiving twice under the same id used to
  // overwrite the first copy in place: retiring a page destroyed the retired
  // page it replaced, in the one directory whose whole purpose is keeping things.
  let target = join(paths.archiveDir, `${id}.md`);
  if (existsSync(target)) {
    const page = await readPage(paths, id);
    const stamp = page?.frontmatter.updated ?? todayISO();
    target = join(paths.archiveDir, `${id}-${stamp}.md`);
    for (let n = 2; existsSync(target); n++) {
      target = join(paths.archiveDir, `${id}-${stamp}-${n}.md`);
    }
  }
  await rename(from, target);
  return target;
}

export async function listPageIds(paths: StorePaths): Promise<string[]> {
  if (!existsSync(paths.pagesDir)) return [];
  const files = await readdir(paths.pagesDir);
  // Normalized, so every id this returns is one readPage can open. Deduped,
  // because two differently-spelled files can share an id and the catalog must
  // not list the same page twice.
  return [...new Set(files.filter((f) => f.endsWith(".md")).map((f) => pageId(basename(f, ".md"))))].sort();
}

// Newest mtime across the inputs maintenance cares about (page files + the
// corrections and custom-voice files), in ms. Cheap: a readdir plus a stat per
// file, no content reads. Used to skip maintenance when nothing changed on disk
// since the last run. Returns 0 on an empty/missing store.
export async function latestStoreMtime(paths: StorePaths): Promise<number> {
  let latest = 0;
  const note = async (p: string): Promise<void> => {
    try {
      const s = await stat(p);
      if (s.mtimeMs > latest) latest = s.mtimeMs;
    } catch {
      // missing file — ignore
    }
  };
  if (existsSync(paths.pagesDir)) {
    // Stat the directory itself too: deleting a page updates the dir's mtime but
    // leaves no file to raise the max, so without this a hand-deleted page would
    // never trigger maintenance and would linger in the index and catalog.
    await note(paths.pagesDir);
    const files = await readdir(paths.pagesDir);
    await Promise.all(files.filter((f) => f.endsWith(".md")).map((f) => note(join(paths.pagesDir, f))));
  }
  await note(paths.voiceCorrections);
  await note(paths.personaFile);
  return latest;
}

export async function readPage(paths: StorePaths, page: string): Promise<Page | null> {
  const path = await resolvePagePath(paths, page);
  if (!path) return null;
  const raw = await readFile(path, "utf8");
  // A page whose front matter will not parse is still a page. Returning null
  // here would delete it from the catalog, the index, the digest and the read
  // tool, with a stderr line as the only trace — and an ordinary YAML slip (a
  // bare colon in a title, a stray horizontal rule at the top of an adopted
  // note) is far more common than a crafted one.
  let parsed: ParsedFrontmatter;
  let frontmatterError: string | undefined;
  try {
    parsed = parseFrontmatter(raw);
  } catch (err) {
    frontmatterError = (err as Error).message;
    warn(`front matter in ${path} could not be read (${frontmatterError}); keeping the page, ignoring its front matter`);
    parsed = { data: {}, content: raw };
  }
  return {
    id: pageId(page),
    path,
    frontmatter: parsed.data as PageFrontmatter,
    body: parsed.content.trim(),
    ...(frontmatterError ? { frontmatterError } : {}),
  };
}

// The file exactly as it sits on disk, frontmatter and all. A caller that reads
// a page in order to write it back needs this: everything else parses the
// frontmatter away, and what is parsed away cannot be written back.
export async function readPageRaw(paths: StorePaths, page: string): Promise<string | null> {
  const path = await resolvePagePath(paths, page);
  if (!path) return null;
  return readFile(path, "utf8");
}

// Where a page actually lives. The canonical path first; failing that, a scan
// for a file whose name normalizes to the same id. Without the fallback, every
// adopted file that was not already lowercase-ASCII-kebab ("My Notes.md",
// "Kraków.md") was listed by the catalog and counted by doctor, and could not
// be opened by anything: two different answers to "what is this page called".
export async function resolvePagePath(paths: StorePaths, page: string): Promise<string | null> {
  // An explicit "archive/..." address looks in archive/. Without this, pageId
  // strips the prefix and the lookup lands back in pages/, so a page that had
  // just been archived was unreachable by any name at all.
  const wantsArchive = page.trim().startsWith("archive/");
  const dir = wantsArchive ? paths.archiveDir : paths.pagesDir;
  const id = pageId(page);
  const canonical = join(dir, `${id}.md`);
  if (existsSync(canonical)) return canonical;
  if (!existsSync(dir)) return null;
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".md")) continue;
    if (pageId(file) === id) return join(dir, file);
  }
  return null;
}

export async function listPages(paths: StorePaths): Promise<PageSummary[]> {
  const ids = await listPageIds(paths);
  const out: PageSummary[] = [];
  for (const id of ids) {
    const page = await readPage(paths, id);
    if (!page) continue;
    out.push({
      id,
      title: page.frontmatter.title ?? id,
      status: page.frontmatter.status,
      updated: page.frontmatter.updated,
    });
  }
  return out;
}

// How a write relates to what is already on the page.
//   "replace" — the payload becomes the whole page. The old default, and still
//               the right call for a rewrite, a merge or a digest proposal.
//   "append"  — the payload is added under what is already there. What the model
//               almost always means by "remember this".
export type WriteMode = "replace" | "append";

export interface WriteResult {
  path: string;
  mode: WriteMode;
  bytesBefore: number;
  bytesAfter: number;
  linesRemoved: number;
  linesAdded: number;
}

// A replace that throws away most of an established page is almost never what
// the caller meant; it is what "remember one fact" looks like when it arrives as
// a whole-page write. Below this much surviving content, refuse and say how to
// proceed on purpose.
const SHRINK_FLOOR = 0.4;
// Below this the page is a stub, and rewriting a stub is ordinary. Roughly two
// short lines: the incident this guard exists for replaced four facts with one.
const SHRINK_GUARD_MIN_BYTES = 120;

export class DestructiveWriteError extends Error {
  constructor(
    readonly id: string,
    readonly bytesBefore: number,
    readonly bytesAfter: number,
    readonly linesRemoved: number,
  ) {
    super(
      `Refusing to replace "${id}": that write drops ${linesRemoved} line(s), ` +
        `${bytesBefore} bytes down to ${bytesAfter}. ` +
        `If you meant to add to the page, call again with mode "append". ` +
        `If you really meant to rewrite it, call again with confirm: true.`,
    );
    this.name = "DestructiveWriteError";
  }
}

// Write a page, ensuring a schema-conformant frontmatter (title/status/updated).
// Existing frontmatter is preserved and the payload merged over it, so a
// read-modify-write cycle cannot quietly drop keys the caller never mentioned.
export async function writePage(
  paths: StorePaths,
  page: string,
  content: string,
  opts: {
    status?: string;
    title?: string;
    now?: Date;
    mode?: WriteMode;
    confirm?: boolean;
  } = {},
): Promise<WriteResult> {
  const id = pageId(page);
  const path = pageFilePath(paths.root, id);
  await mkdir(paths.pagesDir, { recursive: true });

  if (!content.trim()) {
    throw new Error(`Refusing to write an empty page "${id}". Pass content, or archive the page instead.`);
  }

  const mode: WriteMode = opts.mode ?? "replace";
  const existingRaw = existsSync(path) ? await readFile(path, "utf8") : null;
  // The existing file is about to have its front matter rewritten anyway, so a
  // broken one must not block the write. The payload is a different matter:
  // refusing it is the boundary that keeps unparseable content out of the store.
  let existing: ParsedFrontmatter | null = null;
  if (existingRaw !== null) {
    try {
      existing = parseFrontmatter(existingRaw);
    } catch (err) {
      warn(`front matter in ${path} could not be read (${(err as Error).message}); rewriting it`);
      existing = { data: {}, content: existingRaw };
    }
  }
  const existingBody = existing?.content.trim() ?? "";
  const existingFm = (existing?.data ?? {}) as PageFrontmatter;

  const parsed = parseMatter(content, `payload for ${id}`);
  const fm = parsed.data as PageFrontmatter;
  const incomingBody = parsed.content.trim();

  const body = mode === "append" && existingBody ? `${existingBody}\n\n${incomingBody}` : incomingBody;

  if (mode === "replace" && !opts.confirm && existingBody.length >= SHRINK_GUARD_MIN_BYTES) {
    if (body.length < existingBody.length * SHRINK_FLOOR) {
      throw new DestructiveWriteError(
        id,
        existingBody.length,
        body.length,
        countLines(existingBody) - countLines(body),
      );
    }
  }

  // Auto-detect the page language (metadata) unless the author set it explicitly.
  const lang = fm.lang ?? existingFm.lang ?? detectLanguage(body);

  const merged: PageFrontmatter = {
    ...stripCoreKeys(existingFm),
    title: fm.title ?? existingFm.title ?? opts.title ?? id,
    status: fm.status ?? opts.status ?? existingFm.status ?? "active",
    updated: todayISO(opts.now),
    ...(lang ? { lang } : {}),
    ...stripCoreKeys(fm),
  };

  const out = stringifyFrontmatter("\n" + body + "\n", merged as Record<string, unknown>);
  await writeFile(path, out, "utf8");
  return {
    path,
    mode,
    bytesBefore: existingBody.length,
    bytesAfter: body.length,
    linesRemoved: Math.max(countLines(existingBody) - countLines(body), 0),
    linesAdded: Math.max(countLines(body) - countLines(existingBody), 0),
  };
}

function countLines(text: string): number {
  return text ? text.split("\n").length : 0;
}

function parseMatter(raw: string, what: string): ParsedFrontmatter {
  try {
    return parseFrontmatter(raw);
  } catch (err) {
    throw new Error(`cannot parse front matter in ${what}: ${(err as Error).message}`);
  }
}

function stripCoreKeys(fm: PageFrontmatter): PageFrontmatter {
  const { title, status, updated, ...rest } = fm;
  return rest;
}
