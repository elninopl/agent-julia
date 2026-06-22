import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { StorePaths } from "../store/paths.js";

// Minimal structural types over node:sqlite, so the code doesn't depend on a
// particular @types/node version exposing the (still-experimental) sqlite types.
interface Stmt {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}
export interface DB {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
}

// SQLite is Node's built-in node:sqlite (no native module to compile or ship).
// Loaded lazily so a Node older than 24 gets a clear message instead of a raw
// "Cannot find module 'node:sqlite'".
const require = createRequire(import.meta.url);
let DatabaseSyncCtor: (new (path: string) => DB) | null = null;
function loadDatabaseSync(): new (path: string) => DB {
  if (DatabaseSyncCtor) return DatabaseSyncCtor;
  try {
    DatabaseSyncCtor = (require("node:sqlite") as { DatabaseSync: new (path: string) => DB })
      .DatabaseSync;
    return DatabaseSyncCtor;
  } catch (err) {
    throw new Error(
      "agent-julia needs Node.js 24+ (it uses the built-in node:sqlite). " +
        `Current: ${process.version}. Original error: ${(err as Error).message}`,
    );
  }
}

// Bump when the derived index's shape changes in a way the tokenizer signature
// doesn't already capture. The index is disposable: on a signature mismatch we
// drop and rebuild from the markdown.
export const INDEX_SCHEMA_VERSION = 3;
const INDEX_SIG_KEY = "index_signature";

// Choose the FTS tokenizer from the store's primary language:
// - CJK / Thai (no word spacing): the `trigram` tokenizer matches substrings, so
//   search works without a word segmenter.
// - everything else: Porter stemming + diacritics folding, so "Lodz" finds
//   "Łódź" and "debug" finds "debugging".
export function ftsTokenizerFor(language: string): string {
  const l = language.trim().toLowerCase();
  if (/^(zh|ja|ko|th|cmn|jpn|kor|tha|yue|中|日|한|ไ)/.test(l)) return "trigram";
  return "porter unicode61 remove_diacritics 2";
}

// Open (and lazily create) the derived index database. The index is disposable
// and rebuilt from the canonical markdown, so it can be dropped and recreated on
// any schema/tokenizer/model mismatch.
export function openDb(paths: StorePaths, tokenizer: string): DB {
  mkdirSync(dirname(paths.dbPath), { recursive: true });
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(paths.dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  // Multiple Claude surfaces each open their own handle on this file. Wait for a
  // concurrent writer's lock instead of throwing SQLITE_BUSY on the first clash.
  db.exec("PRAGMA busy_timeout = 5000;");

  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  // The signature folds in the schema version and the active tokenizer; if either
  // changed, drop the derived tables and let the next sync rebuild them from the
  // canonical markdown (page_meta empty => every page is re-added).
  const signature = `${INDEX_SCHEMA_VERSION}:${tokenizer}`;
  if (getMeta(db, INDEX_SIG_KEY) !== signature) {
    db.exec("DROP TABLE IF EXISTS pages_fts; DROP TABLE IF EXISTS page_meta; DROP TABLE IF EXISTS embeddings;");
  }
  initSchema(db, tokenizer);
  setMeta(db, INDEX_SIG_KEY, signature);
  return db;
}

function initSchema(db: DB, tokenizer: string): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
      id UNINDEXED,
      title,
      body,
      tokenize = '${tokenizer}'
    );

    CREATE TABLE IF NOT EXISTS embeddings (
      id     TEXT PRIMARY KEY,
      model  TEXT NOT NULL,
      dims   INTEGER NOT NULL,
      vector BLOB NOT NULL
    );

    -- Content fingerprint per page, so incremental sync can detect pages changed
    -- out-of-band (the user edits the markdown by hand) and reindex only those.
    CREATE TABLE IF NOT EXISTS page_meta (
      id   TEXT PRIMARY KEY,
      hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function getPageHash(db: DB, id: string): string | undefined {
  const row = db.prepare("SELECT hash FROM page_meta WHERE id = ?").get(id) as
    | { hash: string }
    | undefined;
  return row?.hash;
}

export function setPageHash(db: DB, id: string, hash: string): void {
  db.prepare(
    "INSERT INTO page_meta (id, hash) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET hash = excluded.hash",
  ).run(id, hash);
}

export function deletePageHash(db: DB, id: string): void {
  db.prepare("DELETE FROM page_meta WHERE id = ?").run(id);
}

export function allIndexedIds(db: DB): string[] {
  const rows = db.prepare("SELECT id FROM page_meta").all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export function getMeta(db: DB, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
