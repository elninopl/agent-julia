// A page by its headings. A page absorbed from Claude Code's memory holds one
// section per fact and runs to hundreds of them; returned whole, one `read` of
// it was about 86,000 tokens, for the one fact a pointer had sent the agent to.

export interface Section {
  heading: string;
  level: number;
  // Line range in the body, end exclusive. Starts at the heading line.
  start: number;
  end: number;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

// Every heading outside a fenced code block, with the lines it covers: up to
// the next heading at its own level or above.
export function sections(body: string): Section[] {
  const lines = body.split("\n");
  const found: Array<{ heading: string; level: number; start: number }> = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced) return;
    const m = HEADING.exec(line);
    if (m) found.push({ heading: m[2]!, level: m[1]!.length, start: i });
  });
  return found.map((h, k) => {
    const next = found.slice(k + 1).find((o) => o.level <= h.level);
    return { ...h, end: next ? next.start : lines.length };
  });
}

const norm = (s: string): string => s.trim().replace(/^#+\s*/, "").replace(/\s+/g, " ").toLowerCase();
const slug = (s: string): string => norm(s).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");

// The section whose heading matches `name`, ignoring case, spacing and
// punctuation, so the name a pointer quotes finds its heading either way.
export function extractSection(body: string, name: string): { heading: string; text: string } | null {
  const lines = body.split("\n");
  const all = sections(body);
  const hit = all.find((s) => norm(s.heading) === norm(name)) ?? all.find((s) => slug(s.heading) === slug(name));
  if (!hit) return null;
  return { heading: hit.heading, text: lines.slice(hit.start, hit.end).join("\n").trim() };
}

// Top-level sections with their size, for a page too long to return whole.
export function tableOfContents(body: string): Array<{ heading: string; chars: number }> {
  const lines = body.split("\n");
  const all = sections(body);
  if (all.length === 0) return [];
  const top = Math.min(...all.map((s) => s.level));
  return all
    .filter((s) => s.level === top)
    .map((s) => ({ heading: s.heading, chars: lines.slice(s.start, s.end).join("\n").length }));
}

// Shift every heading so the shallowest one sits at `level`. Used on text
// placed under a heading of its own, so its headings stay inside that section
// instead of ending it.
export function demoteHeadings(text: string, level: number): string {
  const lines = text.split("\n");
  const levels = sections(text).map((s) => s.level);
  if (levels.length === 0) return text;
  const shift = level - Math.min(...levels);
  if (shift <= 0) return text;
  let fenced = false;
  return lines
    .map((line) => {
      if (FENCE.test(line)) fenced = !fenced;
      if (fenced) return line;
      const m = HEADING.exec(line);
      if (!m) return line;
      return `${"#".repeat(Math.min(6, m[1]!.length + shift))} ${m[2]}`;
    })
    .join("\n");
}
