import { Indexer } from "../index/indexer.js";
import { StorePaths, pageId } from "./paths.js";
import { writePage } from "./markdown.js";
import { appendLog, refreshIndexMd } from "./catalog.js";
import { commitAll, pushToRemote } from "./git.js";

export interface IngestResult {
  id: string;
  path: string;
  committed: boolean;
  pushed: boolean;
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
  opts: { status?: string; title?: string; git?: boolean; autoPush?: boolean } = {},
): Promise<IngestResult> {
  const id = pageId(page);
  // writePage only cares about status/title; git/autoPush are handled below.
  const path = await writePage(paths, id, content, { status: opts.status, title: opts.title });
  await refreshIndexMd(paths);
  await appendLog(paths, `ingest \`${id}\``);
  await indexer.indexPage(id);
  const committed = opts.git === false ? false : await commitAll(paths.root, `Update memory: ${id}`);
  const pushed = committed && opts.autoPush ? await pushToRemote(paths.root) : false;
  return { id, path, committed, pushed };
}
