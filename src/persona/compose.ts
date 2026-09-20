import { existsSync } from "node:fs";
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
  // assets/ is copied next to the compiled module by the build step. Only the
  // rules are injected: drop the credits below the "---", the H1 title (composeCore
  // adds its own header), and any HTML comments — attribution stays out of the
  // hot path.
  const raw = await readFile(join(here, "assets", "core-voice.md"), "utf8");
  return raw
    .split(/\n-{3,}\n/)[0]!
    .replace(/^#[^\n]*\n/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
}

// The L2 voice: a custom voice from persona.md when stylePreset is "custom",
// otherwise the chosen preset's voice.
async function loadVoice(paths: StorePaths, config: Config): Promise<string> {
  if (config.stylePreset === "custom") {
    if (existsSync(paths.personaFile)) {
      const text = (await readFile(paths.personaFile, "utf8")).trim();
      if (text) return text;
    }
    return "Custom voice — define it in persona.md.";
  }
  return PRESETS[config.stylePreset].voice;
}

export interface ComposedCore {
  text: string;
  tokens: number;
  budget: number;
  // The body (identity + universal core + style voice) did not fit and was cut.
  truncated: boolean;
  // Corrections that did not fit. They stay in voice-corrections.md, but they are
  // NOT in context, so callers must be able to say so.
  droppedCorrections: number;
}

// Budget shares. The elastic part is OUR text, not the user's: when the core
// doesn't fit, the universal communication rules shrink, because identity, the
// voice the user wrote, and the corrections they recorded are the whole point of
// the product. Unused share flows down the ladder, so a short voice leaves more
// room for the rules and vice versa.
const CORRECTIONS_SHARE = 0.45;
const VOICE_SHARE = 0.35;
// Floors, applied when the budget cannot hold everything. Slightly overflowing
// the budget beats emitting a persona with no rules, no voice or no corrections.
const MIN_CORE_TOKENS = 120;
const MIN_CORRECTIONS_TOKENS = 120;
// Blank lines joining the sections.
const SEPARATOR_TOKENS = 10;

// Build the budgeted persona core for injection — written as direct instruction,
// not a serialized config. Precedence is by ordering: corrections (last, labeled
// as overriding) win over the universal core, which sits over the style voice.
// The full knowledge base stays on disk; only this compact core enters context.
export async function composeCore(paths: StorePaths, config: Config): Promise<ComposedCore> {
  const coreVoice = await loadCoreVoice();
  const voice = await loadVoice(paths, config);
  const corrections = await readCorrections(paths);

  // Identity and the privacy rail come off the top: both are small and neither is
  // ever worth cutting.
  const identity =
    `# ${config.name}\n` +
    `You are ${config.name} (${config.pronouns}). Respond in ${config.language} — ` +
    `code, docs, and commit messages stay in English.`;
  const privacy = `## Never store\n` + config.privacyHardOff.map((p) => `- ${p}`).join("\n");

  const remaining = Math.max(
    config.contextBudget - estimateTokens(identity) - estimateTokens(privacy) - SEPARATOR_TOKENS,
    0,
  );

  // L3 corrections: highest precedence, capped so an append-only list that grew
  // for months cannot claim the whole budget.
  let correctionsBlock = "";
  let droppedCorrections = 0;
  if (corrections.length > 0) {
    const header = "## Corrections from the user — these win over everything above";
    const counter = (n: number) =>
      `- (+${n} older correction(s) in voice-corrections.md — consolidate them there)`;
    const room = Math.max(
      Math.floor(remaining * CORRECTIONS_SHARE) -
        estimateTokens(header) -
        // The "+N older" line is part of the block too, so it is paid for upfront
        // rather than pushing the core over budget once something is dropped.
        estimateTokens(counter(corrections.length)),
      MIN_CORRECTIONS_TOKENS,
    );
    const kept: string[] = [];
    let used = 0;
    for (const c of [...corrections].reverse()) {
      const t = estimateTokens(c);
      if (used + t > room) {
        droppedCorrections++;
        continue;
      }
      kept.unshift(c);
      used += t;
    }
    if (droppedCorrections > 0) kept.push(counter(droppedCorrections));
    correctionsBlock = `${header}\n${kept.join("\n")}`;
  }

  // L2 voice: the user's own words (persona.md) or the preset they picked. Gets
  // its share plus whatever the corrections left unused.
  const voiceBlock = `## Your voice\n${voice}`;
  const voiceRoom = Math.max(
    Math.floor(remaining * (CORRECTIONS_SHARE + VOICE_SHARE)) - estimateTokens(correctionsBlock),
    Math.floor(remaining * VOICE_SHARE),
  );
  const clampedVoice = clampToBudget(voiceBlock, voiceRoom);

  // L1 universal core: ours, generic, and therefore the part that yields. It takes
  // everything nobody else claimed.
  const coreBlock = `## How you communicate\n${coreVoice}`;
  const coreRoom = Math.max(
    remaining - estimateTokens(correctionsBlock) - estimateTokens(clampedVoice),
    MIN_CORE_TOKENS,
  );
  const clampedCore = clampToBudget(coreBlock, coreRoom);

  // Precedence is by ordering: later sections win. Corrections sit last (above
  // only the privacy rail) because they override everything above them.
  const parts = [identity, clampedCore, clampedVoice];
  if (correctionsBlock) parts.push(correctionsBlock);
  parts.push(privacy);
  const text = parts.join("\n\n");

  return {
    text,
    tokens: estimateTokens(text),
    budget: config.contextBudget,
    // Measured, not predicted: the old check compared against a budget the clamp
    // had already been given, and was read by nothing.
    truncated: clampedCore.length < coreBlock.length || clampedVoice.length < voiceBlock.length,
    droppedCorrections,
  };
}
