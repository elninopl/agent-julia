import { join } from "node:path";
import type { Config } from "../config/schema.js";

// Canonical store layout (the wiki schema, enforced in code):
//   index.md   — catalog of pages, always current
//   log.md     — append-only journal of ingests
//   pages/     — one entity per page (kebab-case .md)
//   archive/   — read-only, retired pages
//   .agent-julia/  — derived/internal state (index db, migration state, backups)
export interface StorePaths {
  root: string;
  // Where persona.md and voice-corrections.md live: the store itself, unless
  // the config's personaDir points somewhere else.
  personaRoot: string;
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

export function storePaths(root: string, personaRoot: string = root): StorePaths {
  const internalDir = join(root, ".agent-julia");
  return {
    root,
    personaRoot,
    indexMd: join(root, "index.md"),
    logMd: join(root, "log.md"),
    pagesDir: join(root, "pages"),
    archiveDir: join(root, "archive"),
    internalDir,
    dbPath: join(internalDir, "index.sqlite"),
    migrationStatePath: join(internalDir, "migrations.json"),
    backupsDir: join(internalDir, "backups"),
    voiceCorrections: join(personaRoot, "voice-corrections.md"),
    personaFile: join(personaRoot, "persona.md"),
  };
}

// The primary store, with the persona read from personaDir when it is set.
export function primaryPaths(config: Pick<Config, "memoryDir" | "personaDir">): StorePaths {
  return storePaths(config.memoryDir, config.personaDir ?? config.memoryDir);
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
// "Kraków" into "krak-w" and "café" into "caf".
export function pageId(page: string): string {
  // Backslashes too: on Windows a caller naturally passes "pages\\elnino.md",
  // and the prefix strip below is written for one separator.
  let id = page.trim().normalize("NFKC").replace(/\\/g, "/");
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
