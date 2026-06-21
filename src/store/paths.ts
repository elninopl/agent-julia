import { join } from "node:path";

// Canonical store layout (the wiki schema, enforced in code):
//   index.md   — catalog of pages, always current
//   log.md     — append-only journal of ingests
//   pages/     — one entity per page (kebab-case .md)
//   archive/   — read-only, retired pages
//   .agent-julia/  — derived/internal state (index db, migration state, backups)
export interface StorePaths {
  root: string;
  indexMd: string;
  logMd: string;
  pagesDir: string;
  archiveDir: string;
  internalDir: string;
  dbPath: string;
  migrationStatePath: string;
  backupsDir: string;
  // Persona L3 corrections live in the store so they travel with the user's data.
  voiceCorrections: string;
}

export function storePaths(root: string): StorePaths {
  const internalDir = join(root, ".agent-julia");
  return {
    root,
    indexMd: join(root, "index.md"),
    logMd: join(root, "log.md"),
    pagesDir: join(root, "pages"),
    archiveDir: join(root, "archive"),
    internalDir,
    dbPath: join(internalDir, "index.sqlite"),
    migrationStatePath: join(internalDir, "migrations.json"),
    backupsDir: join(internalDir, "backups"),
    voiceCorrections: join(root, "voice-corrections.md"),
  };
}

// Map a page id ("elnino", "pages/elnino", "pages/elnino.md") to its file path.
export function pageFilePath(root: string, page: string): string {
  return join(root, "pages", `${pageId(page)}.md`);
}

// Normalize any page reference to its canonical id (no dir, no extension,
// lowercase kebab-case) so links and filenames match regardless of how they
// were typed.
export function pageId(page: string): string {
  let id = page.trim();
  if (id.startsWith("pages/")) id = id.slice("pages/".length);
  if (id.startsWith("archive/")) id = id.slice("archive/".length);
  if (id.endsWith(".md")) id = id.slice(0, -3);
  return id.toLowerCase();
}
