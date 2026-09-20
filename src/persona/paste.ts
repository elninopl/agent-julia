import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "../config/schema.js";
import { StorePaths } from "../store/paths.js";
import { composeCore } from "./compose.js";
import { memoryInstruction } from "./startup.js";

const here = dirname(fileURLToPath(import.meta.url));

// The shape of the text the user is asked to paste into Claude Desktop's
// instruction field. Bump it when the template changes in a way that makes an
// existing paste wrong, so `doctor` can tell "yours is old" from "yours is fine".
export const PASTE_LAYOUT = 2;

// The stable layer: everything that a human has to paste by hand, and nothing
// that does not. Identity, output language and the privacy rail change once a
// year; the voice and the corrections change every few days, and those are
// fetched at runtime instead. Deliberately frozen — it is NOT generated from
// core-voice.md, because a paste that changes with every npm release is the
// treadmill this exists to end.
export async function pasteBody(config: Config): Promise<string> {
  // Same reason as core-voice: a CRLF checkout must not change what is pasted.
  const template = (await readFile(join(here, "assets", "paste-v2.md"), "utf8")).replace(/\r\n/g, "\n");
  return template
    .replaceAll("{{name}}", config.name)
    .replaceAll("{{pronouns}}", config.pronouns)
    .replaceAll("{{language}}", config.language)
    .replaceAll("{{privacy}}", config.privacyHardOff.map((p) => `- ${p}`).join("\n"))
    .trim();
}

// The long variant: today's behaviour, kept for anyone whose account reaches
// surfaces with no MCP server at all (the web app, the phone), where the fetch
// instruction has nothing to fetch from. It does go stale; that is the trade.
export async function pasteWithVoice(paths: StorePaths, config: Config): Promise<string> {
  const core = await composeCore(paths, config);
  // The same sentinel the short template carries, so the probe and doctor can
  // tell a deliberate long paste from the pre-0.1.39 block it looks exactly
  // like. Without it, choosing --with-voice got you told to throw your voice
  // away on every doctor run.
  return `${WITH_VOICE_HEADER}\n${core.text}\n\n${memoryInstruction()}`;
}

export const WITH_VOICE_HEADER =
  "<!-- agent-julia paste, layout 2 (with voice). Replace this whole block when agent-julia asks. -->";

export function pasteHash(body: string): string {
  return createHash("sha1").update(body.trim()).digest("hex");
}

// The part of the paste that comes from the user's own config, as opposed to the
// shipped template. Kept separate so a reworded template does not produce a
// warning that blames the user for a change they did not make.
export function configFingerprint(config: Config): string {
  return createHash("sha1")
    .update([config.name, config.pronouns, config.language, ...config.privacyHardOff].join("|"))
    .digest("hex");
}
