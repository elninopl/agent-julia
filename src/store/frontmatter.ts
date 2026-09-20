import { dump, load } from "js-yaml";

// Front matter, split by hand over js-yaml.
//
// This replaces gray-matter, for two reasons. It ships a `javascript` engine
// that parses front matter with `eval`, selected by the language token after
// the opening delimiter (`---js`) — and the content here is not ours: pages
// arrive through `git pull`, through adopting someone's notes folder, and as
// whatever a model passes to `ingest`. And it pins js-yaml 3.x, which is end of
// life and carries a high-severity advisory that `npm audit fix` cannot resolve.
// The part of it this project used is a delimiter split and a YAML parse.

const OPEN = /^﻿?---\r?\n/;

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  content: string;
}

// Parse a document into its front matter and its body. A document with no front
// matter is all body. Anything after the opening delimiter must be YAML: a
// language token (`---js`, `---toml`) is refused rather than handed to a parser
// that can run it.
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const firstBreak = raw.indexOf("\n");
  const firstLine = (firstBreak === -1 ? raw : raw.slice(0, firstBreak)).replace(/^﻿/, "").trimEnd();

  if (firstLine.startsWith("---") && firstLine.length > 3) {
    throw new Error(
      `front matter in "${firstLine.slice(3)}" is not supported; use YAML delimited by ---`,
    );
  }
  if (!OPEN.test(raw)) return { data: {}, content: raw };

  const body = raw.replace(OPEN, "");
  const close = body.search(/^---[ \t]*\r?(?:\n|$)/m);
  if (close === -1) return { data: {}, content: raw }; // unterminated: it is not front matter

  const yaml = body.slice(0, close);
  const rest = body.slice(close).replace(/^---[ \t]*\r?\n?/, "");

  let data: unknown;
  try {
    data = load(yaml, { schema: undefined });
  } catch (err) {
    throw new Error(`front matter is not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (data === null || data === undefined) return { data: {}, content: rest };
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error("front matter must be a mapping of keys to values");
  }
  return { data: data as Record<string, unknown>, content: rest };
}

// Render front matter and body back into a document. Keys with no value are
// dropped rather than written as `key: null`.
export function stringifyFrontmatter(content: string, data: Record<string, unknown>): string {
  const clean = Object.fromEntries(
    Object.entries(data).filter(([, v]) => v !== undefined && v !== null),
  );
  if (Object.keys(clean).length === 0) return content;
  const yaml = dump(clean, { lineWidth: -1, noRefs: true });
  return `---\n${yaml}---\n${content}`;
}
