import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Config, ExtraStore, extraStores } from "../config/schema.js";
import { Indexer } from "../index/indexer.js";
import { migrate } from "../migrations/runner.js";
import { log, warn } from "../util/log.js";
import { ensureGitRepo } from "./git.js";
import { StorePaths, pageId, storePaths } from "./paths.js";

// A store the server reads: the primary one (memoryDir) or one mounted next to
// it. `config` is the config as this store sees it: its own directory, git
// switch and remote; everything else is shared with the primary.
export interface MountedStore {
  // null for the primary, whose pages keep bare ids.
  name: string | null;
  paths: StorePaths;
  indexer: Indexer;
  config: Config;
  write: boolean;
}

// The config a mounted store's maintenance, git and migrations run against.
export function storeConfigView(config: Config, store: ExtraStore, gitAvailable: boolean): Config {
  const view: Config = { ...config, memoryDir: store.dir, git: store.git && gitAvailable, gitAutoPush: store.gitAutoPush };
  if (store.gitRemote) view.gitRemote = store.gitRemote;
  else delete view.gitRemote;
  return view;
}

// Open every store listed in the config. A store that cannot be mounted is
// skipped with a warning, never taking the primary down with it. Mounted
// stores borrow the primary's embedding provider, and their persona files are
// the primary's: an extra store's persona.md is never read.
export async function mountExtraStores(
  config: Config,
  primary: { paths: StorePaths; indexer: Indexer },
  gitAvailable: boolean,
): Promise<MountedStore[]> {
  const out: MountedStore[] = [];
  const taken = new Set([resolve(config.memoryDir)]);
  for (const store of extraStores(config)) {
    const dir = resolve(store.dir);
    if (taken.has(dir)) {
      warn(`store "${store.name}" points at ${dir}, which is already mounted; skipped`);
      continue;
    }
    if (!existsSync(dir)) {
      warn(`store "${store.name}": ${dir} does not exist; skipped`);
      continue;
    }
    taken.add(dir);
    try {
      const view = storeConfigView(config, { ...store, dir }, gitAvailable);
      await migrate(view, { persistConfig: false });
      if (view.git) await ensureGitRepo(dir);
      const paths = storePaths(dir, primary.paths.personaRoot);
      const indexer = Indexer.open(paths, view, primary.indexer.provider, { shared: true });
      out.push({ name: store.name, paths, indexer, config: view, write: store.write });
      log(`store "${store.name}" mounted from ${dir}${store.write ? "" : " (read-only)"}`);
    } catch (err) {
      warn(`store "${store.name}" could not be mounted (${(err as Error).message}); skipped`);
    }
  }
  return out;
}

// The names a page reference can carry as a prefix.
export function mountedNames(config: Config): ReadonlySet<string> {
  return new Set(extraStores(config).map((s) => s.name));
}

const PREFIX_RE = /^\s*([A-Za-z][A-Za-z0-9-]{1,31}):([\s\S]*)$/;

// "team:pricing" is page "pricing" of the mounted store "team". The prefix
// counts only when it names a mounted store; anything else is a page of the
// primary store and is normalised exactly as before, so a page id that has
// always contained a colon keeps working. The rest goes through pageId, which
// keeps its traversal guarantees: the prefix selects a configured directory,
// it never becomes part of a path.
export function splitStoreRef(ref: string, names: ReadonlySet<string>): { store: string | null; page: string } {
  const m = PREFIX_RE.exec(ref);
  if (m && names.has(m[1]!.toLowerCase())) return { store: m[1]!.toLowerCase(), page: m[2]! };
  return { store: null, page: ref };
}

export function qualify(store: string | null, id: string): string {
  return store ? `${store}:${id}` : id;
}

const LINK_RE = /\[\[([^\]]+)\]\]/g;

// The [[links]] in a body as written, before normalisation.
export function extractLinkRefs(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(LINK_RE)) {
    const ref = m[1]?.split("|")[0]?.trim();
    if (ref) out.add(ref);
  }
  return [...out];
}

// Where a link from a page of `from` leads: a prefixed link to a mounted store
// crosses over, a bare one stays in its own store.
export function linkTarget(
  ref: string,
  from: string | null,
  names: ReadonlySet<string>,
): { store: string | null; id: string } {
  const { store, page } = splitStoreRef(ref, names);
  return store ? { store, id: pageId(page) } : { store: from, id: pageId(ref) };
}
