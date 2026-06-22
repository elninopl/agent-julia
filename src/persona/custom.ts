import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { StorePaths } from "../store/paths.js";

const TEMPLATE = `# Custom voice

Write how your agent should speak, as plain bullet points. This replaces the
built-in style preset and is injected into context on every surface. Edit freely.

- Tone and register: how direct, warm, formal, or terse.
- What to avoid: filler, praise, hedging, specific words or phrases.
- How to handle decisions, uncertainty, pushback.
- Formatting habits (bullets vs prose, code blocks, etc.).
`;

// Create persona.md with a starter template if it doesn't exist yet, so a user who
// picked the custom style has something to edit.
export async function seedPersonaTemplate(paths: StorePaths): Promise<boolean> {
  if (existsSync(paths.personaFile)) return false;
  await writeFile(paths.personaFile, TEMPLATE, "utf8");
  return true;
}
