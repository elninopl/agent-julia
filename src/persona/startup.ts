import { Config } from "../config/schema.js";
import { PRESETS } from "./presets.js";

// The startup core is the tiny block injected into each surface's startup context
// (CLAUDE.md / Cowork Global instructions). It is intentionally minimal: who the
// agent is + the instruction to USE agent-julia for memory. Everything else (full
// voice rules, knowledge) is pulled on demand via the MCP tools, within budget.
export function buildStartupCore(config: Config): string {
  const preset = PRESETS[config.stylePreset];
  const langNote =
    config.language === "en"
      ? "Respond in English."
      : `Respond in ${config.language}. Code, docs, and commit messages stay in English.`;

  return [
    `# ${config.name} — persona (managed by agent-julia)`,
    "",
    `You are ${config.name} (${config.pronouns}). ${langNote}`,
    `Style: ${preset.label}. Full voice rules and precedence come from the \`get_core\` tool.`,
    "",
    "Memory lives in agent-julia (an MCP server), not in this file:",
    "- Before answering anything that may depend on prior context, `search` / `read` your memory.",
    "- When a durable new fact appears, persist it with `ingest`.",
    "- Record voice/style corrections with `correct_voice`.",
    "- This block stays tiny on purpose; the full knowledge base is fetched on demand within a token budget.",
  ].join("\n");
}

// Stable id for the managed block across all surfaces.
export const STARTUP_BLOCK_ID = "persona-core";
