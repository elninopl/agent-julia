import { Config } from "../config/schema.js";
import { Indexer } from "../index/indexer.js";
import { StorePaths } from "../store/paths.js";
import { extractLinks, listPageIds, listPages, readPage } from "../store/markdown.js";
import { refreshIndexMd } from "../store/catalog.js";
import { commitAll } from "../store/git.js";
import { composeCore } from "../persona/compose.js";

export interface MaintenanceReport {
  mode: "auto" | "interactive";
  indexAdded: number;
  indexUpdated: number;
  indexRemoved: number;
  reembedded: boolean;
  orphanLinks: Array<{ from: string; to: string }>;
  staleFlagged: Array<{ id: string; updated: string }>;
  coreTokens: number;
  coreBudget: number;
  coreTruncated: boolean;
  committed: boolean;
  // Interactive-only proposals are deferred to v0.2; empty for now.
  proposals: string[];
}

// Days after which a dated fact is FLAGGED (never auto-deleted) as possibly stale.
const STALE_AFTER_DAYS = 270;

// Automatic maintenance:
// - sync the derived index (and re-embed if the model changed)
// - flag (not delete) orphan cross-links and stale-dated facts
// - refresh index.md, recompact the budgeted core
// - commit any markdown changes
export async function runMaintenance(
  paths: StorePaths,
  indexer: Indexer,
  config: Config,
  mode: "auto" | "interactive" = "auto",
): Promise<MaintenanceReport> {
  const reembedded = await indexer.reembedIfStale();
  const synced = await indexer.sync();

  const ids = new Set(await listPageIds(paths));
  const orphanLinks: Array<{ from: string; to: string }> = [];
  const staleFlagged: Array<{ id: string; updated: string }> = [];
  const cutoff = Date.now() - STALE_AFTER_DAYS * 24 * 3600 * 1000;

  for (const id of ids) {
    const page = await readPage(paths, id);
    if (!page) continue;
    for (const link of extractLinks(page.body)) {
      if (!ids.has(link)) orphanLinks.push({ from: id, to: link });
    }
    const updated = page.frontmatter.updated;
    if (updated && Date.parse(updated) < cutoff) staleFlagged.push({ id, updated });
  }

  await refreshIndexMd(paths);
  const core = await composeCore(paths, config);

  const committed = config.git
    ? await commitAll(paths.root, "Maintain memory: reindex and refresh catalog")
    : false;

  return {
    mode,
    indexAdded: synced.added,
    indexUpdated: synced.updated,
    indexRemoved: synced.removed,
    reembedded,
    orphanLinks,
    staleFlagged,
    coreTokens: core.tokens,
    coreBudget: core.budget,
    coreTruncated: core.truncated,
    committed,
    proposals: [],
  };
}

// Lightweight stats for the resource/tooling surface.
export async function storeStats(paths: StorePaths): Promise<{ pages: number }> {
  return { pages: (await listPages(paths)).length };
}
