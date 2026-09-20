import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { StorePaths } from "../store/paths.js";
import { todayISO } from "../store/markdown.js";

// L3 — user voice corrections. Append-only, highest precedence. Kept separate from
// preset (L2) and core (L1) and surfaced into the injected core.
// A single correction that runs longer than this is a document, not a rule, and
// it crowds out the ones after it.
const MAX_CORRECTION_CHARS = 600;

const HEADER = `# Voice corrections

> Append-only. Captured via the \`correct_voice\` tool. Highest precedence — these
> override the style preset and the universal core. Newest at the bottom.
`;

export async function appendCorrection(paths: StorePaths, note: string): Promise<void> {
  if (!existsSync(paths.voiceCorrections)) {
    await writeFile(paths.voiceCorrections, HEADER + "\n", "utf8");
  }
  // Bounded and single-line. This text goes into the always-on prompt of every
  // surface with no review step, and the reader only ever takes the first line,
  // so a long or multi-line correction was silently half-applied.
  const clean = note.trim().replace(/\s+/g, " ").slice(0, MAX_CORRECTION_CHARS);
  await appendFile(paths.voiceCorrections, `- ${todayISO()} — ${clean}\n`, "utf8");
}

// Withdraw a correction. Commented out rather than deleted: the file is the
// record of how the user's voice was shaped, and "we used to have this rule and
// dropped it on this date" is worth more than a gap. Until this existed, the
// only way to take a rule out of the global prompt of every surface was to open
// the markdown by hand.
export async function retractCorrection(
  paths: StorePaths,
  match: string,
): Promise<
  | { status: "ok"; retracted: string }
  | { status: "none" }
  | { status: "ambiguous"; candidates: string[] }
> {
  if (!existsSync(paths.voiceCorrections)) return { status: "none" };
  const raw = await readFile(paths.voiceCorrections, "utf8");
  const needle = match.trim().toLowerCase();
  const lines = raw.split("\n");
  const hits = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.startsWith("- ") && l.toLowerCase().includes(needle));
  if (hits.length === 0) return { status: "none" };
  if (hits.length > 1) {
    return { status: "ambiguous", candidates: hits.map((h) => h.l.slice(2, 120)) };
  }
  const { l, i } = hits[0]!;
  lines[i] = `<!-- retracted ${todayISO()}: ${l.replace(/^- /, "")} -->`;
  await writeFile(paths.voiceCorrections, lines.join("\n"), "utf8");
  return { status: "ok", retracted: l.replace(/^- /, "") };
}

export async function readCorrections(paths: StorePaths): Promise<string[]> {
  if (!existsSync(paths.voiceCorrections)) return [];
  const raw = await readFile(paths.voiceCorrections, "utf8");
  const lines = raw
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.replace(/^- \d{4}-\d{2}-\d{2} — /, "- ").trim());
  // Repeating a correction is common ("stop doing X" said twice, months apart);
  // surface each distinct rule once, keeping its most recent position.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const l of [...lines].reverse()) {
    const key = l.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.unshift(l);
  }
  return deduped;
}
