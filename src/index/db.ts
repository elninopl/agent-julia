import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { StorePaths } from "../store/paths.js";

export type DB = BetterSqlite3.Database;

// better-sqlite3 is a native module loaded on demand, so a missing or unbuilt
// binary surfaces as a clear, actionable message instead of a raw stack trace.
const require = createRequire(import.meta.url);
let DatabaseCtor: typeof BetterSqlite3 | null = null;
function loadDatabaseCtor(): typeof BetterSqlite3 {
  if (DatabaseCtor) return DatabaseCtor;
  try {
    DatabaseCtor = require("better-sqlite3") as typeof BetterSqlite3;
    return DatabaseCtor;
  } catch (err) {
    throw new Error(
      "agent-julia could not load its search engine (the native better-sqlite3 module). " +
        "This usually means no prebuilt binary exists for your Node version or platform. " +
        "Try `npm rebuild better-sqlite3`, or reinstall on a supported Node LTS (20 or 22).\n" +
        `Original error: ${(err as Error).message}`,
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
  const Database = loadDatabaseCtor();
  const db = new Database(paths.dbPath);
  db.pragma("journal_mode = WAL");

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
