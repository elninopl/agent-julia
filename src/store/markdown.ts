import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import matter from "gray-matter";
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
export async function archivePage(paths: StorePaths, page: string): Promise<boolean> {
  const id = pageId(page);
  const from = pageFilePath(paths.root, id);
  if (!existsSync(from)) return false;
  await mkdir(paths.archiveDir, { recursive: true });
  await rename(from, join(paths.archiveDir, `${id}.md`));
  return true;
}

export async function listPageIds(paths: StorePaths): Promise<string[]> {
  if (!existsSync(paths.pagesDir)) return [];
  const files = await readdir(paths.pagesDir);
  return files
    .filter((f) => f.endsWith(".md"))
    .map((f) => basename(f, ".md"))
    .sort();
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
  const path = pageFilePath(paths.root, page);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf8");
  const parsed = matter(raw);
  return {
    id: pageId(page),
    path,
    frontmatter: parsed.data as PageFrontmatter,
    body: parsed.content.trim(),
  };
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

// Write a page, ensuring a schema-conformant frontmatter (title/status/updated).
// Returns the absolute path written.
export async function writePage(
  paths: StorePaths,
  page: string,
  content: string,
  opts: { status?: string; title?: string; now?: Date } = {},
): Promise<string> {
  const id = pageId(page);
  const path = pageFilePath(paths.root, id);
  await mkdir(paths.pagesDir, { recursive: true });

  const parsed = matter(content);
  const fm = parsed.data as PageFrontmatter;
  // Body may have come without frontmatter; in that case parsed.content === content.
  const body = parsed.content.trim();

  // Auto-detect the page language (metadata) unless the author set it explicitly.
  const lang = fm.lang ?? detectLanguage(body);

  const merged: PageFrontmatter = {
    title: fm.title ?? opts.title ?? id,
    status: fm.status ?? opts.status ?? "active",
    updated: todayISO(opts.now),
    ...(lang ? { lang } : {}),
    ...stripCoreKeys(fm),
  };

  const out = matter.stringify("\n" + body + "\n", merged);
  await writeFile(path, out, "utf8");
  return path;
}

function stripCoreKeys(fm: PageFrontmatter): PageFrontmatter {
  const { title, status, updated, ...rest } = fm;
  return rest;
}
