// Dependency-free token estimate for budgeting the injected core. Exact counts
// aren't needed, only a stable upper bound to compact against.
// Heuristic: ~4 characters per token for prose and markdown.
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// Trim text to roughly fit a token budget. Cuts on the largest structural
// boundary that still keeps most of the budget: a paragraph break, then a line
// break, then a word boundary. Never cuts mid-word — a half-written rule reads
// to the model as a rule, and the injected core is instruction, not prose.
export function clampToBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimateTokens(text) <= maxTokens) return text;
  const maxChars = maxTokens * 4;
  const slice = text.slice(0, maxChars);
  const keepAtLeast = maxChars * 0.5;

  const paragraph = slice.lastIndexOf("\n\n");
  if (paragraph > keepAtLeast) return slice.slice(0, paragraph).trimEnd();

  const line = slice.lastIndexOf("\n");
  if (line > keepAtLeast) return slice.slice(0, line).trimEnd();

  // No usable structure left: drop the trailing partial word. When that would
  // leave nothing (a single long token, or whitespace only at the very start),
  // keep the raw slice rather than returning an empty section.
  const onWord = slice.replace(/\S+$/, "").trimEnd();
  return onWord.length > 0 ? onWord : slice.trimEnd();
}
