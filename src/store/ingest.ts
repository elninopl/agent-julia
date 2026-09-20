import { Indexer } from "../index/indexer.js";
import { StorePaths, pageId } from "./paths.js";
import { WriteMode, writePage } from "./markdown.js";
import { appendLog, refreshIndexMd } from "./catalog.js";
import { commitAll, pushToRemote } from "./git.js";
import { withStoreLock } from "./lock.js";

export interface IngestResult {
  id: string;
  path: string;
  mode: WriteMode;
  bytesBefore: number;
  bytesAfter: number;
  linesAdded: number;
  linesRemoved: number;
  committed: boolean;
  pushed: boolean;
}

// Schema-enforcing write path:
//   1. write/update the page (conformant frontmatter, absolute updated date)
//   2. refresh index.md (the catalog)
//   3. append to log.md (the journal)
//   4. reindex this page (FTS + embeddings)
//   5. commit (the store is versioned)
// The size delta travels with the result and into the commit message, so a write
// that removed more than it added is visible in `git log` without reading a diff.
export async function ingest(
  paths: StorePaths,
  indexer: Indexer,
  page: string,
  content: string,
  opts: {
    status?: string;
    title?: string;
    git?: boolean;
    autoPush?: boolean;
    mode?: WriteMode;
    confirm?: boolean;
  } = {},
): Promise<IngestResult> {
  const id = pageId(page);
  // One lock around the whole sequence. Guarding only the git step left the page
  // write, the catalog refresh, the journal append and the index update exposed:
  // two surfaces writing at once could interleave a page write with another
  // page's catalog refresh and lose one of them.
  const result = await withStoreLock(paths.root, () => ingestLocked(paths, indexer, id, content, opts));
  if (!result) {
    throw new Error(
      `another agent-julia process is writing to this store and did not finish in time; "${id}" was not saved. Try again.`,
    );
  }
  return result;
}

async function ingestLocked(
  paths: StorePaths,
  indexer: Indexer,
  id: string,
  content: string,
  opts: {
    status?: string;
    title?: string;
    git?: boolean;
    autoPush?: boolean;
    mode?: WriteMode;
    confirm?: boolean;
  },
): Promise<IngestResult> {
  // writePage only cares about the page itself; git/autoPush are handled below.
  const w = await writePage(paths, id, content, {
    status: opts.status,
    title: opts.title,
    mode: opts.mode,
    confirm: opts.confirm,
  });
  await refreshIndexMd(paths);
  await appendLog(paths, `ingest \`${id}\` (${w.mode}, +${w.linesAdded}/-${w.linesRemoved} lines)`);
  await indexer.indexPage(id);
  const delta = w.linesRemoved > 0 ? ` (+${w.linesAdded}/-${w.linesRemoved} lines)` : "";
  const committed =
    opts.git === false ? false : await commitAll(paths.root, `Update memory: ${id}${delta}`);
  const pushed = committed && opts.autoPush ? await pushToRemote(paths.root) : false;
  return {
    id,
    path: w.path,
    mode: w.mode,
    bytesBefore: w.bytesBefore,
    bytesAfter: w.bytesAfter,
    linesAdded: w.linesAdded,
    linesRemoved: w.linesRemoved,
    committed,
    pushed,
  };
}
