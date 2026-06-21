// Dependency-free token estimate for budgeting the injected core. Exact counts
// aren't needed, only a stable upper bound to compact against.
// Heuristic: ~4 characters per token for prose and markdown.
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// Trim text to roughly fit a token budget, cutting on a paragraph boundary when
// possible to avoid leaving a half-sentence in the injected core.
export function clampToBudget(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const maxChars = maxTokens * 4;
  const slice = text.slice(0, maxChars);
  const lastBreak = slice.lastIndexOf("\n\n");
  return (lastBreak > maxChars * 0.5 ? slice.slice(0, lastBreak) : slice).trimEnd();
}
