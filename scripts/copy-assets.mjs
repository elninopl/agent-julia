// Copies non-TS runtime assets (shipped persona markdown + skills) into dist/ after tsc.
import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const jobs = [
  ["src/persona/assets", "dist/persona/assets"],
  ["src/skills/assets", "dist/skills/assets"],
];

for (const [from, to] of jobs) {
  const target = resolve(root, to);
  await mkdir(dirname(target), { recursive: true });
  await cp(resolve(root, from), target, { recursive: true });
  console.log(`copied assets -> ${target}`);
}
