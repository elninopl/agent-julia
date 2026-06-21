import { Config } from "../config/schema.js";
import { StorePaths } from "../store/paths.js";
import { listPageIds, readPage } from "../store/markdown.js";
import { log } from "../util/log.js";
import { DB, openDb } from "./db.js";
import { EmbeddingProvider, makeEmbeddingProvider } from "./embeddings.js";
import { ftsDelete, ftsUpsert } from "./fts.js";
import { SearchResult, search } from "./search.js";
import {
  clearEmbeddings,
  embeddingsAreStale,
  semanticDelete,
  semanticUpsert,
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

  static open(paths: StorePaths, config: Config): Indexer {
    return new Indexer(openDb(paths), makeEmbeddingProvider(config.embedding), paths, config);
  }

  close(): void {
    this.db.close();
  }

  async indexPage(id: string): Promise<void> {
    const page = await readPage(this.paths, id);
    if (!page) {
      this.removePage(id);
      return;
    }
    const title = page.frontmatter.title ?? id;
    ftsUpsert(this.db, id, title, page.body);
    await semanticUpsert(this.db, this.provider, id, `${title}\n\n${page.body}`);
  }

  removePage(id: string): void {
    ftsDelete(this.db, id);
    semanticDelete(this.db, id);
  }

  // Full rebuild from canonical markdown. The index is disposable, so this is the
  // recovery path for any schema/model mismatch.
  async rebuild(): Promise<number> {
    this.db.exec("DELETE FROM pages_fts;");
    clearEmbeddings(this.db);
    const ids = await listPageIds(this.paths);
    for (const id of ids) await this.indexPage(id);
    log(`index rebuilt: ${ids.length} page(s)`);
    return ids.length;
  }

  // If the embedding model changed, stored vectors are stale — drop + re-embed.
  async reembedIfStale(): Promise<boolean> {
    if (!embeddingsAreStale(this.db, this.provider)) return false;
    log("embedding model changed — re-embedding all pages");
    clearEmbeddings(this.db);
    for (const id of await listPageIds(this.paths)) await this.indexPage(id);
    return true;
  }

  search(query: string, limit: number): Promise<SearchResult[]> {
    return search(this.db, this.provider, this.config.search, query, limit);
  }
}
