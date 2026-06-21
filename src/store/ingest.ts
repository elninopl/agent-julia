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

// Schema-enforcing write path:
//   1. write/update the page (conformant frontmatter, absolute updated date)
//   2. refresh index.md (the catalog)
//   3. append to log.md (the journal)
//   4. reindex this page (FTS + embeddings)
//   5. commit (the store is versioned)
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
