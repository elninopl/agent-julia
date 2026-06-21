import { appendFile, writeFile } from "node:fs/promises";
import { StorePaths } from "./paths.js";
import { PageSummary, listPages, todayISO } from "./markdown.js";

// Regenerate index.md from the actual pages on disk. index.md is a derived,
// always-current catalog — never hand-authored source of truth.
export async function refreshIndexMd(paths: StorePaths): Promise<PageSummary[]> {
  const pages = await listPages(paths);
  const lines: string[] = [
    "# Index",
    "",
    "> Auto-generated catalog of pages. Do not edit by hand — regenerated on every ingest.",
    "",
    `_Updated: ${todayISO()} · ${pages.length} page(s)_`,
    "",
  ];
  if (pages.length === 0) {
    lines.push("_No pages yet._", "");
  } else {
    for (const p of pages) {
      const status = p.status ? ` — \`${p.status}\`` : "";
      const updated = p.updated ? ` _(updated ${p.updated})_` : "";
      lines.push(`- [[${p.id}]] — ${p.title}${status}${updated}`);
    }
    lines.push("");
  }
  await writeFile(paths.indexMd, lines.join("\n"), "utf8");
  return pages;
}

// Append one line to the journal. log.md is append-only; the agent reads it for
// recent activity but never rewrites history.
export async function appendLog(paths: StorePaths, entry: string, now = new Date()): Promise<void> {
  const stamp = now.toISOString().replace("T", " ").slice(0, 16);
  await appendFile(paths.logMd, `- ${stamp} — ${entry}\n`, "utf8");
}
