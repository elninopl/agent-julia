import { createInterface, Interface } from "node:readline/promises";

// Thin wrapper over readline so the wizard reads top-to-bottom. All prompts go to
// stdout here (this is the interactive `init` path, not the stdio MCP server).
export class Prompter {
  private rl: Interface;
  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout });
  }

  async text(question: string, fallback?: string): Promise<string> {
    const suffix = fallback ? ` [${fallback}]` : "";
    const ans = (await this.rl.question(`${question}${suffix}: `)).trim();
    return ans || fallback || "";
  }

  async choice<T extends string>(
    question: string,
    options: Array<{ value: T; label: string }>,
    defaultIndex = 0,
  ): Promise<T> {
    console.log(`\n${question}`);
    options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}`));
    const def = defaultIndex + 1;
    const raw = (await this.rl.question(`Choose [1-${options.length}, default ${def}]: `)).trim();
    const idx = raw ? Number.parseInt(raw, 10) - 1 : defaultIndex;
    const picked = options[idx] ?? options[defaultIndex]!;
    return picked.value;
  }

  async confirm(question: string, defaultYes = true): Promise<boolean> {
    const hint = defaultYes ? "Y/n" : "y/N";
    const raw = (await this.rl.question(`${question} [${hint}]: `)).trim().toLowerCase();
    if (!raw) return defaultYes;
    return raw.startsWith("y");
  }

  close(): void {
    this.rl.close();
  }
}
