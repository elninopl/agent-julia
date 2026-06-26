import { Config } from "../config/schema.js";
import { StorePaths } from "../store/paths.js";
import { composeCore } from "./compose.js";

// The instruction half of the injected block: where memory lives and how to use
// it. The persona half is the budgeted core (composeCore), so the full voice —
// preset or custom — is always present, not fetched on demand.
function memoryInstruction(): string {
  return [
    "## Memory (agent-julia)",
    "Your memory lives in agent-julia (an MCP server), not in this file.",
    "- Before answering anything that may depend on what you know about the user, their projects, or past decisions, `search` / `read` your memory first.",
    "- Capture proactively AND visibly: when a durable fact, decision, preference, or change surfaces, `ingest` it yourself — don't wait to be asked — and say in one short line what you saved (e.g. \"saved → prive\"). If a working session produced decisions worth keeping and you saved nothing, that's a miss, not a default. Skip only genuinely transient chatter.",
    "- The reliable channel is the user saying \"remember: X\" / \"save that\" — always act on it. Proactive capture is the bonus on top; don't rely on it silently.",
    "- When the user corrects how you write or speak — even in passing, even mid-task (\"don't say X\", \"that phrasing is off\", \"stop doing Y\") — call `correct_voice` to save it BEFORE you reply, then confirm it's saved. Don't just acknowledge it in chat: an unsaved correction is gone next session.",
    "- Only this core stays in context; the full knowledge base is fetched on demand.",
  ].join("\n");
}

// The full managed block injected into a surface's startup context: the budgeted
// persona core (identity + universal core + style/custom voice + corrections +
// privacy) followed by the memory instruction.
export async function buildInjectedCore(paths: StorePaths, config: Config): Promise<string> {
  const core = await composeCore(paths, config);
  return `${core.text}\n\n${memoryInstruction()}`;
}

// Stable id for the managed block across all surfaces.
export const STARTUP_BLOCK_ID = "persona-core";
