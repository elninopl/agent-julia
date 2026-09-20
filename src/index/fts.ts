import { DB, foldForIndex } from "./db.js";

export interface FtsHit {
  id: string;
  title: string;
  score: number; // higher is better (we negate bm25, which is lower-is-better)
  snippet: string;
  // Which rung of the ladder produced this hit: an exact term match, or a
  // loosened one. Callers surface it so a vague answer is visibly vague.
  via: "fts" | "fts-loose";
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
  db.prepare("INSERT INTO pages_fts (id, title, body, fold) VALUES (?, ?, ?, ?)").run(
    id,
    title,
    body,
    foldForIndex(`${title}\n${body}`),
  );
}

// Words that carry no retrieval signal but, because every term is ANDed, are
// enough on their own to return nothing. A question asked in a sentence is the
// product's headline use case ("what did we decide about auth?"), and every one
// of them failed until the stopwords came out. Kept deliberately small and
// multilingual rather than clever: only words that are almost never the point.
const STOPWORDS = new Set([
  // en
  "a", "an", "and", "are", "as", "at", "be", "did", "do", "does", "for", "from", "how", "i",
  "in", "is", "it", "me", "my", "of", "on", "or", "our", "say", "that", "the", "to", "was",
  "we", "what", "when", "where", "which", "who", "why", "with", "you", "your", "about",
  // pl
  "czy", "co", "jak", "jest", "są", "był", "była", "było", "być", "dla", "do", "i", "ja",
  "jakie", "jaki", "kim", "kto", "który", "która", "które", "moje", "mój", "na", "nie", "o",
  "od", "po", "przez", "się", "to", "w", "we", "z", "za", "że", "gdzie", "kiedy", "ile",
  // es / de / fr, the other languages the tokenizer folds diacritics for
  "el", "la", "los", "las", "de", "del", "que", "und", "der", "die", "das", "ist", "für",
  "le", "les", "des", "une", "est", "pour", "dans",
]);

function terms(query: string): string[] {
  return foldForIndex(query)
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/["'()*^:-]/g, "").trim())
    .filter(Boolean);
}

const quoted = (t: string): string => `"${t}"`;

// bm25 weights per column: (id UNINDEXED, title, body). A hit in the title is
// what the page is ABOUT; a hit in the body may be a passing mention. Without a
// weight the two ranked the same, so asking about "acme cennik" put four other
// pages above the page called "acme — cennik".
const BM25 = "bm25(pages_fts, 0.0, 10.0, 1.0, 0.5)";

function run(db: DB, match: string, limit: number, via: FtsHit["via"]): FtsHit[] {
  let rows: Array<{ id: string; title: string; rank: number; snippet: string }>;
  try {
    rows = db
      .prepare(
        `SELECT id, title,
                ${BM25} AS rank,
                snippet(pages_fts, 2, '«', '»', ' … ', 12) AS snippet
         FROM pages_fts
         WHERE pages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(match, limit) as typeof rows;
  } catch {
    // A malformed MATCH expression is a bad query, not a broken index.
    return [];
  }
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    // bm25 returns NEGATIVE values for matches (more negative = better).
    // A sigmoid over the raw rank maps that to (0, 1) higher-is-better; the old
    // max(0, rank) clamped every match to a flat 1.0.
    score: 1 / (1 + Math.exp(r.rank)),
    snippet: r.snippet,
    via,
  }));
}

// A ladder, not a single query. Every term ANDed is right when the user typed
// keywords and hopeless when they typed a sentence, so each rung loosens only as
// far as the one before it found nothing:
//   1. all terms          — the precise answer, when there is one
//   2. content words only — drops "what did we decide about", keeps "auth"
//   3. any two words      — for a question whose wording does not match the page
// Each hit says which rung it came from, so a caller can tell a precise match
// from a loose one.
export function ftsSearch(db: DB, query: string, limit: number): FtsHit[] {
  const all = terms(query);
  if (all.length === 0) return [];

  const strict = run(db, all.map(quoted).join(" "), limit, "fts");
  if (strict.length > 0) return strict;

  const content = all.filter((t) => !STOPWORDS.has(t));
  if (content.length > 0 && content.length < all.length) {
    const hits = run(db, content.map(quoted).join(" "), limit, "fts");
    if (hits.length > 0) return hits;
  }

  // OR, but requiring two matches, so one common word cannot return the store.
  const pool = content.length > 0 ? content : all;
  if (pool.length >= 2) {
    const expr = pool.map(quoted).join(" OR ");
    const hits = run(db, expr, limit * 3, "fts-loose").filter((h) => {
      const hay = `${h.title} ${h.snippet}`.toLowerCase();
      return pool.filter((t) => hay.includes(t)).length >= 2;
    });
    if (hits.length > 0) return hits.slice(0, limit);
    // Nothing matched two terms: try each word alone, longest first, and take
    // the first that finds anything. "The closest I have" beats "no hits" when
    // the alternative is the user concluding their memory is empty.
    for (const t of [...pool].sort((a, b) => b.length - a.length)) {
      const single = run(db, quoted(t), limit, "fts-loose");
      if (single.length > 0) return single;
    }
    return substringFallback(db, pool, limit);
  }
  return substringFallback(db, all, limit);
}

// The trigram tokenizer, which the index uses for Chinese, Japanese, Korean and
// Thai, cannot match anything shorter than three characters — and one or two
// characters is the ordinary length of a word in exactly those languages. A
// bounded LIKE scan is the honest answer for a query FTS structurally cannot
// serve; it only runs when the ladder above found nothing.
function substringFallback(db: DB, pool: string[], limit: number): FtsHit[] {
  const short = pool.filter((t) => t.length > 0 && t.length < 3);
  if (short.length === 0) return [];
  const term = short.sort((a, b) => b.length - a.length)[0]!;
  try {
    const rows = db
      .prepare(
        `SELECT id, title, substr(body, 1, 160) AS snippet
         FROM pages_fts
         WHERE title LIKE ? OR body LIKE ?
         LIMIT ?`,
      )
      .all(`%${term}%`, `%${term}%`, limit) as Array<{ id: string; title: string; snippet: string }>;
    return rows.map((r) => ({ id: r.id, title: r.title, score: 0.1, snippet: r.snippet, via: "fts-loose" as const }));
  } catch {
    return [];
  }
}
