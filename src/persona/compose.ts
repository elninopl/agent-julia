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
  truncated: boolean;
}

// Build the budgeted persona core for injection — written as direct instruction,
// not a serialized config. Precedence is by ordering: corrections (last, labeled
// as overriding) win over the universal core, which sits over the style voice.
// The full knowledge base stays on disk; only this compact core enters context.
export async function composeCore(paths: StorePaths, config: Config): Promise<ComposedCore> {
  const coreVoice = await loadCoreVoice();
  const voice = await loadVoice(paths, config);
  const corrections = await readCorrections(paths);

  const sections: string[] = [];

  // Identity as a natural sentence, not a key/value dump.
  sections.push(
    `# ${config.name}\n` +
      `You are ${config.name} (${config.pronouns}). Respond in ${config.language} — ` +
      `code, docs, and commit messages stay in English.`,
  );

  // L1 — universal communication rules.
  sections.push(`## How you communicate\n${coreVoice}`);

  // L2 — voice: a preset, or a custom voice from persona.md.
  sections.push(`## Your voice\n${voice}`);

  // Protected tail — never trimmed by the budget. L3 corrections are the highest
  // precedence layer, so they MUST survive; only the lower-precedence body above
  // (identity + universal core + style voice) is clamped if the core is over
  // budget. Privacy hard-off is a safety rail and is protected the same way.
  const tail: string[] = [];
  const privacy = `## Never store\n` + config.privacyHardOff.map((p) => `- ${p}`).join("\n");
  if (corrections.length > 0) {
    // Protected from the body clamp, but not unbounded: an append-only list
    // that grew for months must not eat the whole budget and squeeze the voice
    // down to its 100-token floor. Newest rules win; anything dropped here
    // still lives in voice-corrections.md, and a counter line says so.
    const header = "## Corrections from the user — these win over everything above";
    const room = Math.max(config.contextBudget - estimateTokens(privacy) - estimateTokens(header) - 108, 120);
    const kept: string[] = [];
    let used = 0;
    let dropped = 0;
    for (const c of [...corrections].reverse()) {
      const t = estimateTokens(c);
      if (used + t > room) {
        dropped++;
        continue;
      }
      kept.unshift(c);
      used += t;
    }
    if (dropped > 0) {
      kept.push(`- (+${dropped} older correction(s) in voice-corrections.md — consolidate them there)`);
    }
    tail.push(`${header}\n${kept.join("\n")}`);
  }
  tail.push(privacy);
  const protectedTail = tail.join("\n\n");

  const budgetForBody = Math.max(config.contextBudget - estimateTokens(protectedTail) - 8, 100);
  const body = clampToBudget(sections.join("\n\n"), budgetForBody);
  const text = `${body}\n\n${protectedTail}`;
  const tokens = estimateTokens(text);

  return {
    text,
    tokens,
    budget: config.contextBudget,
    truncated: estimateTokens(sections.join("\n\n")) > budgetForBody,
  };
}
