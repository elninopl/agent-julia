import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import matter from "gray-matter";
import { StorePaths, pageFilePath, pageId } from "./paths.js";

export interface PageFrontmatter {
  title?: string;
  status?: string;
  updated?: string; // absolute date, ISO (YYYY-MM-DD)
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

export async function listPageIds(paths: StorePaths): Promise<string[]> {
  if (!existsSync(paths.pagesDir)) return [];
  const files = await readdir(paths.pagesDir);
  return files
    .filter((f) => f.endsWith(".md"))
    .map((f) => basename(f, ".md"))
    .sort();
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

  const merged: PageFrontmatter = {
    title: fm.title ?? opts.title ?? id,
    status: fm.status ?? opts.status ?? "active",
    updated: todayISO(opts.now),
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
