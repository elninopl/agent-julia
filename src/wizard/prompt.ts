import { createInterface, Interface } from "node:readline/promises";
import { c, wrapText } from "./ui.js";
import { readHidden } from "../util/hidden-input.js";

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  // A plain-language explanation, wrapped under the label.
  desc?: string;
  // Marks the recommended option (also becomes the default).
  recommended?: boolean;
}

const PAD = "  ";

// Thin wrapper over readline, styled for the "guided & warm" wizard. All prompts
// go to stdout (this is the interactive `init` path, not the stdio MCP server).
export class Prompter {
  private rl: Interface;
  private closed = false;
  private suspended = false;
  constructor() {
    this.rl = this.open();
  }

  private open(): Interface {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // If the input stream closes mid-wizard (Ctrl-D, piped EOF), stop rather than
    // racing through every remaining prompt on its default.
    rl.on("close", () => {
      if (!this.suspended) this.closed = true;
    });
    return rl;
  }

  private async ask(defaultHint?: string): Promise<string> {
    if (this.closed) throw new Error("input stream closed — setup aborted");
    const hint = defaultHint ? c.dim(` ${defaultHint}`) : "";
    return (await this.rl.question(`${PAD}${c.cyanBold("❯")}${hint} `)).trim();
  }

  // Free-text input with an optional example line and default value.
  async text(opts: { example?: string; def?: string } = {}): Promise<string> {
    if (opts.example) console.log(PAD + c.dim("e.g. " + opts.example));
    const ans = await this.ask(opts.def ? c.dim(`(${opts.def})`) : undefined);
    return ans || opts.def || "";
  }

  async choice<T extends string>(options: ChoiceOption<T>[]): Promise<T> {
    const defaultIndex = Math.max(0, options.findIndex((o) => o.recommended));
    console.log("");
    options.forEach((o, i) => {
      const badge = o.recommended ? "  " + c.green("★ recommended") : "";
      console.log(`${PAD}  ${c.cyanBold(String(i + 1))}  ${c.bold(o.label)}${badge}`);
      if (o.desc) {
        for (const ln of wrapText(o.desc, 58, "")) console.log(PAD + "     " + c.dim(ln));
      }
      console.log("");
    });
    const def = defaultIndex + 1;
    for (;;) {
      const raw = await this.ask(c.dim(`1–${options.length}, enter = ${def}`));
      if (!raw) return options[defaultIndex]!.value;
      const idx = Number.parseInt(raw, 10) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < options.length) return options[idx]!.value;
      console.log(PAD + c.dim(`Please enter a number between 1 and ${options.length}.`));
    }
  }

  async confirm(question: string, defaultYes = true): Promise<boolean> {
    const hint = defaultYes ? "Y/n" : "y/N";
    const raw = (
      await this.rl.question(`${PAD}${c.cyanBold("❯")} ${c.white(question)} ${c.dim(hint)} `)
    )
      .trim()
      .toLowerCase();
    if (!raw) return defaultYes;
    return raw.startsWith("y");
  }

  // Input that is not echoed, for a token. readline echoes whatever it
  // reads, so it is closed for this one answer, read in raw mode, and opened
  // again.
  async secret(): Promise<string> {
    if (this.closed) throw new Error("input stream closed — setup aborted");
    process.stdout.write(`${PAD}${c.cyanBold("❯")} ${c.dim("(hidden)")} `);
    this.suspended = true;
    this.rl.close();
    try {
      return (await readHidden()).trim();
    } finally {
      this.rl = this.open();
      this.suspended = false;
    }
  }

  close(): void {
    this.rl.close();
  }
}
