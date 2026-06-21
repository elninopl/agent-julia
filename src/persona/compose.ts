import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "../config/schema.js";
import { StorePaths } from "../store/paths.js";
import { clampToBudget, estimateTokens } from "../util/tokens.js";
import { PRESETS } from "./presets.js";
import { readCorrections } from "./corrections.js";

const here = dirname(fileURLToPath(import.meta.url));

async function loadCoreVoice(): Promise<string> {
  // assets/ is copied next to the compiled module by the build step.
  return (await readFile(join(here, "assets", "core-voice.md"), "utf8")).trim();
}

export interface ComposedCore {
  text: string;
  tokens: number;
  budget: number;
  truncated: boolean;
}

// Build the budgeted persona core for injection. Precedence is set by ordering and
// stated explicitly: L3 (corrections) > L1 (universal core) > L2 (style preset).
// The full knowledge base stays on disk; only this compact core enters context.
export async function composeCore(paths: StorePaths, config: Config): Promise<ComposedCore> {
  const preset = PRESETS[config.stylePreset];
  const coreVoice = await loadCoreVoice();
  const corrections = await readCorrections(paths);

  const sections: string[] = [];

  sections.push(
    `# Persona: ${config.name}\n` +
      `- Name: ${config.name}\n` +
      `- Gender/pronouns: ${config.gender} (${config.pronouns})\n` +
      `- Output language: ${config.language} (code, docs, and commits stay in English)\n` +
      `- Style preset: ${preset.label}\n` +
      `- Precedence when rules conflict: user voice corrections > universal core > style preset`,
  );

  // L1 — universal core (above presets).
  sections.push(`## Universal core (always on)\n${coreVoice}`);

  // L2 — style preset flavor.
  sections.push(`## Style: ${preset.label}\n${preset.voice}`);

  // L3 — user corrections (highest precedence). Placed last and labeled as
  // overriding, so the model reads them as the final word.
  if (corrections.length > 0) {
    sections.push(
      `## User voice corrections (override everything above)\n${corrections.join("\n")}`,
    );
  }

  // Privacy hard-off is a safety rail, never trimmed away by the budget.
  const privacy =
    `## Never persist (privacy hard-off)\n` +
    config.privacyHardOff.map((p) => `- ${p}`).join("\n");

  const budgetForBody = Math.max(config.contextBudget - estimateTokens(privacy) - 8, 100);
  const body = clampToBudget(sections.join("\n\n"), budgetForBody);
  const text = `${body}\n\n${privacy}`;
  const tokens = estimateTokens(text);

  return {
    text,
    tokens,
    budget: config.contextBudget,
    truncated: estimateTokens(sections.join("\n\n")) > budgetForBody,
  };
}
