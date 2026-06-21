import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { StorePaths } from "../store/paths.js";

export type DB = Database.Database;

// Open (and lazily create) the derived index database. The index is disposable:
// it can always be rebuilt from the canonical markdown, so we are free to drop and
// recreate it on any schema/model mismatch.
export function openDb(paths: StorePaths): DB {
  mkdirSync(dirname(paths.dbPath), { recursive: true });
  const db = new Database(paths.dbPath);
  db.pragma("journal_mode = WAL");
  initSchema(db);
  return db;
}

function initSchema(db: DB): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
      id UNINDEXED,
      title,
      body,
      tokenize = 'unicode61'
    );

    CREATE TABLE IF NOT EXISTS embeddings (
      id     TEXT PRIMARY KEY,
      model  TEXT NOT NULL,
      dims   INTEGER NOT NULL,
      vector BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
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
