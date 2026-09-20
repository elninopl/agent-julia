import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Migration } from "./types.js";
import { todayISO } from "../store/markdown.js";

// Baseline (schemaVersion 1): establish the canonical store skeleton if missing.
// Idempotent — only creates files that don't already exist.
export const migration0001: Migration = {
  version: 1,
  description: "Initialize canonical store skeleton (index.md, log.md, pages/, archive/)",
  async up({ paths }) {
    await mkdir(paths.pagesDir, { recursive: true });
    await mkdir(paths.archiveDir, { recursive: true });
    await mkdir(paths.internalDir, { recursive: true });

    if (!existsSync(paths.logMd)) {
      await writeFile(
        paths.logMd,
        `# Log\n\n> Append-only journal of memory changes.\n\n- ${todayISO()} 00:00 — store initialized\n`,
        "utf8",
      );
    }
    // Only seed a header on a fresh store; the catalog itself is a managed block
    // that refreshIndexMd owns, so an adopted index.md is never clobbered.
    if (!existsSync(paths.indexMd)) {
      await writeFile(
        paths.indexMd,
        `# Index\n\n> Catalog of pages. The block below is maintained by agent-julia.\n`,
        "utf8",
      );
    }
    // Keep the derived index out of version control; it is rebuildable. The
    // internal dir name is fixed (storePaths), so hardcode it rather than deriving
    // it by stripping the root prefix (which breaks on a trailing slash).
    // Append what is missing rather than skipping the file entirely. Adopting a
    // folder that already had a .gitignore meant the derived index — sqlite plus
    // its -wal and -shm — was staged by `git add -A` on every single write, and
    // then fought the other machine's copy on every pull.
    const wanted = [".agent-julia/", "*.sqlite", "*.sqlite-*"];
    const gitignorePath = join(paths.root, ".gitignore");
    const current = existsSync(gitignorePath) ? await readFile(gitignorePath, "utf8") : "";
    const lines = new Set(current.split("\n").map((l) => l.trim()));
    const missing = wanted.filter((w) => !lines.has(w));
    if (missing.length > 0) {
      const sep = current.length === 0 || current.endsWith("\n") ? "" : "\n";
      await writeFile(gitignorePath, `${current}${sep}${missing.join("\n")}\n`, "utf8");
    }
    // Belt and braces for a store whose .gitignore someone edits later: the
    // internal directory excludes itself.
    await mkdir(paths.internalDir, { recursive: true });
    const selfIgnore = join(paths.internalDir, ".gitignore");
    if (!existsSync(selfIgnore)) await writeFile(selfIgnore, "*\n", "utf8");
  },
};
