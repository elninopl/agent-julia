// Dependency-free ANSI styling for the wizard, "guided & warm" look. Color is
// disabled when stdout is not a TTY (piped/CI) or NO_COLOR is set, so output
// stays clean everywhere.
const useColor =
  (process.env.FORCE_COLOR === "1" || Boolean(process.stdout.isTTY)) && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  italic: wrap("3"),
  green: wrap("32"),
  yellow: wrap("33"),
  cyan: wrap("36"),
  white: wrap("37"),
  gray: wrap("90"),
  cyanBold: (s: string) => (useColor ? `\x1b[1;36m${s}\x1b[0m` : s),
  greenBold: (s: string) => (useColor ? `\x1b[1;32m${s}\x1b[0m` : s),
};

const PAD = "  ";
const RULE_WIDTH = 52;

// Word-wrap to `width`, returning lines prefixed with `indent`.
export function wrapText(text: string, width: number, indent: string): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > width) {
      lines.push(indent + line);
      line = w;
    } else {
      line = line ? line + " " + w : w;
    }
  }
  if (line) lines.push(indent + line);
  return lines;
}

// Warm opening.
export function welcome(name: string): void {
  console.log("");
  console.log(PAD + c.cyanBold("◆ ") + c.bold("Welcome — let's give your AI one brain."));
  console.log("");
  console.log(PAD + c.dim("This takes about a minute. I'll ask a few things, then wire it"));
  console.log(PAD + c.dim("all up. Nothing is locked in — you can change any of it later."));
  void name;
}

// Step header: a rule with a right-aligned "Step n of N", then the topic and a
// plain-language explanation of why this step matters.
export function step(n: number, total: number, topic: string, explain: string): void {
  const label = `Step ${n} of ${total}`;
  const dashes = "─".repeat(Math.max(4, RULE_WIDTH - label.length - 2));
  console.log("");
  console.log(c.gray(`${PAD}${dashes}  ${label}`));
  console.log("");
  console.log(PAD + c.bold(topic) + c.dim("  ·  " + explain));
}

export function examples(text: string): void {
  console.log(PAD + c.dim("e.g. " + text));
}

// A soft caveat (yellow marker, dim text).
export function note(text: string): void {
  for (const [i, ln] of wrapText(text, 62, "").entries()) {
    console.log(PAD + (i === 0 ? c.yellow("› ") : "  ") + c.dim(ln));
  }
}

export function ok(text: string): void {
  console.log(`${PAD}${c.green("✓")} ${text}`);
}

export function info(text: string): void {
  console.log(`${PAD}${c.cyan("›")} ${text}`);
}

// A warm key/value recap with a left rule.
export function summary(title: string, rows: Array<[string, string]>): void {
  const keyW = Math.max(...rows.map(([k]) => k.length));
  console.log("");
  console.log(PAD + c.cyan("┌ ") + c.bold(title));
  for (const [k, v] of rows) {
    console.log(PAD + c.cyan("│ ") + c.gray((k + ":").padEnd(keyW + 1)) + " " + c.white(v));
  }
  console.log(PAD + c.cyan("└"));
}
