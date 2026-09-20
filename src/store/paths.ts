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
  // Optional custom voice (L2) — used when stylePreset is "custom".
  personaFile: string;
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
    personaFile: join(root, "persona.md"),
  };
}

// Map a page id ("elnino", "pages/elnino", "pages/elnino.md") to its file path.
export function pageFilePath(root: string, page: string): string {
  return join(root, "pages", `${pageId(page)}.md`);
}

// Normalize any page reference to its canonical id (no dir, no extension,
// lowercase) so links and filenames match regardless of how they were typed.
// The id is also a security boundary: MCP callers control this string and it
// becomes a filename under pages/, so path separators, control characters and
// dot runs are collapsed and an id can never traverse out of the store.
//
// Letters and digits are kept in any script. The old rule allowed [a-z0-9._-]
// only, which mapped every name written in Cyrillic, Greek, Chinese, Japanese,
// Korean or Thai to the single id "untitled" — so in those languages every page
// was the same file, and each new one destroyed the last. The same rule turned
// "Kraków" into "krak-w" and "ofeô" into "ofe".
export function pageId(page: string): string {
  let id = page.trim().normalize("NFKC");
  if (id.startsWith("pages/")) id = id.slice("pages/".length);
  if (id.startsWith("archive/")) id = id.slice("archive/".length);
  if (id.endsWith(".md")) id = id.slice(0, -3);
  id = id.toLowerCase();
  // Anything that is not a letter, a digit or one of . _ - becomes a separator.
  // Path separators and control characters fall in here, which is the boundary.
  id = id.replace(/[^\p{L}\p{N}._-]+/gu, "-");
  id = id.replace(/\.{2,}/g, ".");
  id = id.replace(/^[-._]+|[-._]+$/g, "");
  return id || "untitled";
}
