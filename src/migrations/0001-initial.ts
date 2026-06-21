import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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
    // Keep the derived index out of version control; it is rebuildable.
    const gitignore = `${paths.internalDir.replace(paths.root + "/", "")}/\n*.sqlite\n*.sqlite-*\n`;
    const gitignorePath = `${paths.root}/.gitignore`;
    if (!existsSync(gitignorePath)) {
      await writeFile(gitignorePath, gitignore, "utf8");
    }
  },
};
