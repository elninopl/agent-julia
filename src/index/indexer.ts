import { createHash } from "node:crypto";
import { Config } from "../config/schema.js";
import { StorePaths } from "../store/paths.js";
import { listPageIds, readPage } from "../store/markdown.js";
import { withStoreLock } from "../store/lock.js";
import { log } from "../util/log.js";
import {
  DB,
  allIndexedIds,
  deletePageHash,
  ftsTokenizerFor,
  getPageHash,
  openDb,
  setPageHash,
} from "./db.js";
import { EmbeddingProvider, makeEmbeddingProvider } from "./embeddings.js";
import { ftsDelete, ftsUpsert } from "./fts.js";
import { SearchResult, search } from "./search.js";
import {
  clearEmbeddings,
  dropOtherModels,
  embedChunks,
  knownVectors,
  pagesWithoutVectors,
  semanticDelete,
  semanticStore,
} from "./semantic.js";

// Facade over the derived index (FTS + embeddings). Owns the DB handle and the
// embedding provider; everything that touches the index goes through here.
export class Indexer {
  private constructor(
    readonly db: DB,
    readonly provider: EmbeddingProvider,
    private readonly paths: StorePaths,
    private readonly config: Config,
  ) {}

  // `provider` is an injection seam for tests; production callers omit it.
  static open(paths: StorePaths, config: Config, provider?: EmbeddingProvider): Indexer {
    const db = openDb(paths, ftsTokenizerFor(config.language));
    return new Indexer(db, provider ?? makeEmbeddingProvider(config.embedding), paths, config);
  }

  close(): void {
    this.provider.close?.();
    // Truncate the WAL back into the main db on clean shutdown so the -wal file
    // doesn't linger large and mmapped for the next readers. Best-effort.
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // a concurrent writer may hold the lock; the autocheckpoint will catch up
    }
    this.db.close();
  }

  async indexPage(id: string): Promise<void> {
    const page = await readPage(this.paths, id);
    if (!page) {
      this.removePage(id);
      return;
    }
    const title = page.frontmatter.title ?? id;
    // Embed first (async, no lock held), then write FTS row, vector, and hash in
    // one transaction so a crash can't leave a recorded hash for a page whose
    // embedding never landed (which sync() would never re-embed).
    const known = this.provider.enabled ? knownVectors(this.db, id, this.provider.id) : undefined;
    const vectors = await embedChunks(this.provider, title, page.body, known);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      ftsUpsert(this.db, id, title, page.body);
      if (vectors && vectors.length > 0) semanticStore(this.db, this.provider, id, vectors);
      setPageHash(this.db, id, hashPage(title, page.body));
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  removePage(id: string): void {
    ftsDelete(this.db, id);
    semanticDelete(this.db, id);
    deletePageHash(this.db, id);
  }

  // Incremental sync: reindex only pages whose content changed (detected by hash,
  // so hand-edits to the markdown are caught), add new pages, drop deleted ones.
  // Cheap enough to run on every startup — and it never re-embeds an unchanged
  // page, so it won't hammer a remote embedding API.
  async sync(): Promise<{ added: number; updated: number; removed: number }> {
    const diskIds = new Set(await listPageIds(this.paths));
    const indexed = new Set(allIndexedIds(this.db));
    let added = 0;
    let updated = 0;
    let removed = 0;

    for (const id of diskIds) {
      const page = await readPage(this.paths, id);
      if (!page) continue;
      const hash = hashPage(page.frontmatter.title ?? id, page.body);
      if (getPageHash(this.db, id) === hash) continue;
      await this.indexPage(id);
      if (indexed.has(id)) updated++;
      else added++;
    }
    for (const id of indexed) {
      if (!diskIds.has(id)) {
        this.removePage(id);
        removed++;
      }
    }
    return { added, updated, removed };
  }

  // Full rebuild from canonical markdown. The index is disposable, so this is the
  // recovery path for any schema/model mismatch.
  async rebuild(): Promise<number> {
    this.db.exec("DELETE FROM pages_fts; DELETE FROM page_meta;");
    clearEmbeddings(this.db);
    const ids = await listPageIds(this.paths);
    for (const id of ids) await this.indexPage(id);
    log(`index rebuilt: ${ids.length} page(s)`);
    return ids.length;
  }

  // Embed every indexed page that has no vectors from the active model: the
  // whole store after a change of model or precision, otherwise the pages whose
  // embed failed (or that were indexed while the provider was off — sync()
  // alone would not catch those, the page hashes are unchanged).
  //
  // Page by page, replacing each page's old vectors as its new ones land, so
  // nothing is wiped up front. And one process at a time: every session runs
  // this at boot, and after an upgrade that changed the fingerprint, a dozen
  // sessions reloading together each re-embedded the whole store in parallel,
  // each with its own copy of the model. Whoever finds the lock taken skips;
  // whatever the holder does not finish, the next boot picks up.
  async reembedIfStale(): Promise<boolean> {
    if (!this.provider.enabled) return false;
    if (pagesWithoutVectors(this.db, this.provider.id).length === 0) return false;
    const ran = await withStoreLock(
      this.paths.root,
      async () => {
        const missing = pagesWithoutVectors(this.db, this.provider.id);
        if (missing.length === 0) return false;
        log(`embedding ${missing.length} page(s) with ${this.provider.id}`);
        for (const id of missing) await this.indexPage(id);
        if (pagesWithoutVectors(this.db, this.provider.id).length === 0) dropOtherModels(this.db, this.provider.id);
        return true;
      },
      { name: "embed", waitMs: 0 },
    );
    return ran ?? false;
  }

  search(query: string, limit: number): Promise<SearchResult[]> {
    return search(this.db, this.provider, this.config.search, query, limit);
  }
}

function hashPage(title: string, body: string): string {
  return createHash("sha1").update(`${title}\n\n${body}`).digest("hex");
}
