import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { StorePaths } from "../store/paths.js";
import { todayISO } from "../store/markdown.js";

// L3 — user voice corrections. Append-only, highest precedence. Kept separate from
// preset (L2) and core (L1) and surfaced into the injected core.
const HEADER = `# Voice corrections

> Append-only. Captured via the \`correct_voice\` tool. Highest precedence — these
> override the style preset and the universal core. Newest at the bottom.
`;

export async function appendCorrection(paths: StorePaths, note: string): Promise<void> {
  if (!existsSync(paths.voiceCorrections)) {
    await writeFile(paths.voiceCorrections, HEADER + "\n", "utf8");
  }
  const clean = note.trim().replace(/\s+/g, " ");
  await appendFile(paths.voiceCorrections, `- ${todayISO()} — ${clean}\n`, "utf8");
}

export async function readCorrections(paths: StorePaths): Promise<string[]> {
  if (!existsSync(paths.voiceCorrections)) return [];
  const raw = await readFile(paths.voiceCorrections, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.replace(/^- \d{4}-\d{2}-\d{2} — /, "- ").trim());
}
