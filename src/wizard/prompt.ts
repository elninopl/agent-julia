import { createInterface, Interface } from "node:readline/promises";
import { c } from "./ui.js";

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  // Optional consequence/explanation line shown dimmed under the label.
  hint?: string;
}

// Thin wrapper over readline so the wizard reads top-to-bottom. All prompts go to
// stdout here (this is the interactive `init` path, not the stdio MCP server).
export class Prompter {
  private rl: Interface;
  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout });
  }

  private arrow(): string {
    return c.cyan("  › ");
  }

  async text(question: string, fallback?: string): Promise<string> {
    const suffix = fallback ? c.dim(` (${fallback})`) : "";
    console.log(`${c.bold(question)}${suffix}`);
    const ans = (await this.rl.question(this.arrow())).trim();
    return ans || fallback || "";
  }

  async choice<T extends string>(
    question: string,
    options: ChoiceOption<T>[],
    defaultIndex = 0,
  ): Promise<T> {
    console.log(c.bold(question));
    options.forEach((o, i) => {
      const def = i === defaultIndex ? c.green(" (default)") : "";
      console.log(`    ${c.cyanBold(String(i + 1))}  ${c.white(o.label)}${def}`);
      if (o.hint) console.log(c.dim(`        ${o.hint}`));
    });
    const def = defaultIndex + 1;
    const raw = (await this.rl.question(this.arrow() + c.dim(`1-${options.length} (${def}) `))).trim();
    const idx = raw ? Number.parseInt(raw, 10) - 1 : defaultIndex;
    const picked = options[idx] ?? options[defaultIndex]!;
    return picked.value;
  }

  async confirm(question: string, defaultYes = true): Promise<boolean> {
    const hint = defaultYes ? c.dim("(Y/n)") : c.dim("(y/N)");
    const raw = (await this.rl.question(`  ${c.cyan("›")} ${c.bold(question)} ${hint} `))
      .trim()
      .toLowerCase();
    if (!raw) return defaultYes;
    return raw.startsWith("y");
  }

  close(): void {
    this.rl.close();
  }
}
