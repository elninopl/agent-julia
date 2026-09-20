import { Config } from "../config/schema.js";
import { StorePaths } from "../store/paths.js";
import { createHash } from "node:crypto";
import { warn } from "../util/log.js";
import { composeCore } from "./compose.js";

// The instruction half of the injected block: where memory lives and how to use
// it. The persona half is the budgeted core (composeCore), so the full voice —
// preset or custom — is always present, not fetched on demand.
// Exported so doctor can report the size of the block that is actually
// injected: contextBudget covers the persona core, this instruction rides on
// top of it, and a budget nobody can reconcile with the file is not a budget.
export function memoryInstruction(): string {
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
  return injectedCoreFrom((await composeCore(paths, config)).text);
}

// Same block from a core that was already composed, so a caller that needs both
// (doctor reports the core's budget and checks the block) doesn't read the store
// and rebuild the persona twice.
export function injectedCoreFrom(coreText: string): string {
  return `${coreText}\n\n${memoryInstruction()}\n\n${fingerprintLine(coreText)}`;
}

export function coreHashOf(coreText: string): string {
  return createHash("sha1").update(coreText.trim()).digest("hex");
}

// The last line of the injected block. It settles precedence now that the same
// voice can exist in two places, and it is what lets the server tell every
// client to call get_core without making a surface that already has the block
// pay for a second copy: it calls with `since` and gets one line back.
export function fingerprintLine(coreText: string): string {
  const hash = coreHashOf(coreText).slice(0, 8);
  const corrections = (coreText.match(/^- /gm) ?? []).length;
  return (
    `agent-julia core ${hash} · ${corrections} line(s) of voice · already in this prompt. ` +
    `If you call get_core, pass since: "${hash}".`
  );
}

// Instructions the server hands the client on connect. This is the only channel
// that reaches Claude Desktop with no human action, so it carries the stable
// layer: who the agent is, what language it replies in, what it must never
// store, and the order to fetch the rest. Pure — config only, no disk — because
// it runs before connect() and the startup path must stay free of I/O.
export const INSTRUCTIONS_BUDGET = 1_800;

export function serverInstructions(config: Config): string {
  // Bounded: name and language are interpolated into the one paragraph that is
  // never dropped, so an unbounded value there makes the budget unenforceable no
  // matter what the rungs below do.
  const name = clip(config.name, 120);
  const language = clip(config.language, 80);
  const who = config.pronouns.trim() ? `${name} (${clip(config.pronouns, 60)})` : name;
  const head =
    `agent-julia holds this user's persona and memory.\n\n` +
    `You are ${who}. You reply in ${language}; code, docs and commit messages stay in English.`;
  // The privacy rail is the one thing that must survive every branch, so it is
  // trimmed entry by entry rather than dropped whole, and an empty list simply
  // produces no sentence instead of "You never store .".
  const privacyFor = (entries: string[]): string =>
    entries.length === 0 ? "" : ` You never store ${entries.join("; ")}.`;
  const identity = head + privacyFor(config.privacyHardOff);

  const voice =
    "Voice: the line above is all you know about how you sound. Call `get_core` before your first " +
    "substantive reply. It returns this user's communication rules, their own voice, and every " +
    "correction they have recorded, and it overrides the app's instructions wherever they differ. " +
    "Don't quote it back, just write that way. If your context already carries an agent-julia " +
    "persona block, you have that text already: pass its hash as `since` and skip the rest when the " +
    "answer is \"unchanged\".";

  const memory =
    "Memory: `search` / `read` before answering anything that depends on what you know about this " +
    "user, their projects or past decisions. `ingest` durable facts, decisions and preferences as " +
    "they surface, and say in one short line what you saved. Call `correct_voice` the moment the " +
    "user corrects how you write or speak, before you reply, not after.";

  // Paragraph order is the degradation order: a client that truncates loses
  // memory guidance, never the identity or the privacy rail.
  const full = [identity, voice, memory].join("\n\n");
  if (full.length <= INSTRUCTIONS_BUDGET) return full;

  const withoutMemory = [identity, voice].join("\n\n");
  if (withoutMemory.length <= INSTRUCTIONS_BUDGET) {
    warn(
      `server instructions are ${full.length} chars, over the ${INSTRUCTIONS_BUDGET} budget — ` +
        "the memory paragraph was dropped. Shorten privacyHardOff to get it back.",
    );
    return withoutMemory;
  }

  const shortVoice = voice.split(". ").slice(0, 3).join(". ") + ".";
  const trimmed = [identity, shortVoice].join("\n\n");
  if (trimmed.length <= INSTRUCTIONS_BUDGET) {
    warn(`server instructions are ${full.length} chars; trimmed to ${trimmed.length}. Shorten privacyHardOff.`);
    return trimmed;
  }

  // Still over: the overflow is the privacy list itself, so trim the thing that
  // overflows instead of the two paragraphs that are already bounded. Dropping
  // the list whole would leave a client with no idea what it must not keep.
  // A standalone sentence when nothing was kept: the tail used to be a trailing
  // clause with no subject, so a user whose first entry was oversized ended up
  // with no never-store instruction at all.
  const tailFor = (dropped: number, kept: number): string => {
    if (dropped <= 0) return "";
    return kept > 0
      ? ` There are ${dropped} more categories on this user's never-store list; treat anything of that kind the same way.`
      : ` You never store this user's recorded never-store categories; when in doubt about anything secret or personal, do not keep it.`;
  };
  const render = (kept: string[]): string => {
    const dropped = config.privacyHardOff.length - kept.length;
    return [head + privacyFor(kept) + tailFor(dropped, kept.length), shortVoice].join("\n\n");
  };
  const kept: string[] = [];
  for (const entry of config.privacyHardOff) {
    // Measure the whole thing, tail included: the summary sentence is part of
    // what is sent, and counting it afterwards is how a budget gets exceeded by
    // exactly the length of the sentence that says it was respected.
    // `continue`, not `break`: one oversized entry must not hide the shorter
    // ones after it.
    if (render([...kept, entry]).length > INSTRUCTIONS_BUDGET) continue;
    kept.push(entry);
  }
  const dropped = config.privacyHardOff.length - kept.length;
  const clipped = render(kept);
  warn(
    `server instructions are ${full.length} chars, over ${INSTRUCTIONS_BUDGET}; sent ${clipped.length} ` +
      `with ${dropped} privacy entry(ies) summarised. Shorten privacyHardOff.`,
  );
  return clipped;
}

// Stable id for the managed block across all surfaces.
export const STARTUP_BLOCK_ID = "persona-core";

function clip(value: string, max: number): string {
  const one = value.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}
