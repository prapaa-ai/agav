/** Standard Levenshtein edit distance between two strings. */
export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] !== b[j - 1] ? 1 : 0),
      );
  return dp[m]![n]!;
}

/**
 * Closest candidate to `input` within edit distance 3, or undefined.
 * Candidates whose length differs from the input by more than 2 are skipped
 * so wildly different strings never get suggested.
 */
export function findClosest(input: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDist = 4;
  for (const candidate of candidates) {
    if (Math.abs(input.length - candidate.length) > 2) continue;
    const d = levenshtein(input, candidate);
    if (d < bestDist) { bestDist = d; best = candidate; }
  }
  return best;
}
