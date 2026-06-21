// Tiny dependency-free ANSI styling for the wizard. Color is disabled when stdout
// is not a TTY (piped/CI) or NO_COLOR is set, so output stays clean everywhere.
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  reset: wrap("0"),
  bold: wrap("1"),
  dim: wrap("2"),
  italic: wrap("3"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
  white: wrap("37"),
  gray: wrap("90"),
  cyanBold: (s: string) => (useColor ? `\x1b[1;36m${s}\x1b[0m` : s),
  greenBold: (s: string) => (useColor ? `\x1b[1;32m${s}\x1b[0m` : s),
};

// Opening banner.
export function banner(): void {
  const title = " agent-julia · setup ";
  console.log("");
  console.log(c.cyanBold("  ┌" + "─".repeat(title.length) + "┐"));
  console.log(c.cyanBold("  │") + c.bold(title) + c.cyanBold("│"));
  console.log(c.cyanBold("  └" + "─".repeat(title.length) + "┘"));
  console.log(c.dim("  one brain for your AI — local-first memory + persona\n"));
}

// "Step 3/10" badge + the question, on its own line.
export function step(n: number, total: number, question: string): void {
  console.log("");
  console.log(`${c.gray(`[${n}/${total}]`)} ${c.bold(question)}`);
}

export function hintLine(text: string): void {
  console.log(c.dim(`      ${text}`));
}

// A left-ruled key/value summary. Left-bar style avoids ragged right borders on
// variable-width content (long paths).
export function summaryBox(title: string, rows: Array<[string, string]>): void {
  const keyW = Math.max(...rows.map(([k]) => k.length));
  console.log("");
  console.log(c.cyan("  ┌─ ") + c.bold(title));
  for (const [k, v] of rows) {
    console.log(c.cyan("  │  ") + c.gray((k + ":").padEnd(keyW + 1)) + " " + c.white(v));
  }
  console.log(c.cyan("  └─"));
}

export function ok(text: string): void {
  console.log(`  ${c.green("✓")} ${text}`);
}

export function info(text: string): void {
  console.log(`  ${c.cyan("›")} ${text}`);
}
