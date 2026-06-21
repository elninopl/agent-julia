// Cheap, dependency-free token estimate. Good enough for budgeting the injected
// core; we never need exact counts, only a stable upper bound to compact against.
// Heuristic: ~4 characters per token for English/Polish prose + markdown.
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// Trim text to roughly fit a token budget, cutting on a paragraph boundary when
// possible so we never leave a half-sentence in the hot path.
export function clampToBudget(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const maxChars = maxTokens * 4;
  const slice = text.slice(0, maxChars);
  const lastBreak = slice.lastIndexOf("\n\n");
  return (lastBreak > maxChars * 0.5 ? slice.slice(0, lastBreak) : slice).trimEnd();
}
