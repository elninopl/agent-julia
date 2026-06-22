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
    "- Capture proactively: when a durable fact, decision, preference, or change surfaces in a conversation, `ingest` it yourself — don't wait to be asked. If unsure whether it's worth keeping, lean toward a short note over losing it. Skip transient or trivial chatter.",
    "- Record voice/style corrections with `correct_voice`.",
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
