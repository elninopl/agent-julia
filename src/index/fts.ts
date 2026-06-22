import { DB } from "./db.js";

export interface FtsHit {
  id: string;
  title: string;
  score: number; // higher is better (we negate bm25, which is lower-is-better)
  snippet: string;
}

export function ftsDelete(db: DB, id: string): void {
  db.prepare("DELETE FROM pages_fts WHERE id = ?").run(id);
}

// Look up a page's title from the index — used to give semantic-only hits a real
// title instead of falling back to the raw id.
export function ftsTitle(db: DB, id: string): string | undefined {
  const row = db.prepare("SELECT title FROM pages_fts WHERE id = ?").get(id) as
    | { title: string }
    | undefined;
  return row?.title;
}

export function ftsUpsert(db: DB, id: string, title: string, body: string): void {
  ftsDelete(db, id);
  db.prepare("INSERT INTO pages_fts (id, title, body) VALUES (?, ?, ?)").run(id, title, body);
}

// Escape a user query into an FTS5 MATCH expression: quote each term so symbols
// can't break the parser, then AND them (FTS5's implicit space operator) so a
// multi-word query narrows results instead of flooding them with any-term hits.
function toMatch(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/["']/g, "").trim())
    .filter(Boolean)
    .map((t) => `"${t}"`);
  return terms.length ? terms.join(" ") : '""';
}

export function ftsSearch(db: DB, query: string, limit: number): FtsHit[] {
  const match = toMatch(query);
  if (match === '""') return [];
  const rows = db
    .prepare(
      `SELECT id, title,
              bm25(pages_fts) AS rank,
              snippet(pages_fts, 2, '«', '»', ' … ', 12) AS snippet
       FROM pages_fts
       WHERE pages_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(match, limit) as Array<{ id: string; title: string; rank: number; snippet: string }>;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    // bm25 returns lower-is-better; normalize to a positive higher-is-better score.
    score: 1 / (1 + Math.max(0, r.rank)),
    snippet: r.snippet,
  }));
}
