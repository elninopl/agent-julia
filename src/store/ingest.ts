import { Indexer } from "../index/indexer.js";
import { StorePaths, pageId } from "./paths.js";
import { writePage } from "./markdown.js";
import { appendLog, refreshIndexMd } from "./catalog.js";
import { commitAll } from "./git.js";

export interface IngestResult {
  id: string;
  path: string;
  committed: boolean;
}

// The one write path that enforces the schema end-to-end:
//   1. write/update the page (schema-conformant frontmatter, absolute updated date)
//   2. refresh index.md (always-current catalog)
//   3. append to log.md (append-only journal)
//   4. update the derived index (FTS + embeddings) for just this page
//   5. git commit (the canonical store is versioned)
export async function ingest(
  paths: StorePaths,
  indexer: Indexer,
  page: string,
  content: string,
  opts: { status?: string; title?: string } = {},
): Promise<IngestResult> {
  const id = pageId(page);
  const path = await writePage(paths, id, content, opts);
  await refreshIndexMd(paths);
  await appendLog(paths, `ingest \`${id}\``);
  await indexer.indexPage(id);
  const committed = await commitAll(paths.root, `chore(memory): ingest ${id}`);
  return { id, path, committed };
}
