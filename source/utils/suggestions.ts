/**
 * Levenshtein edit distance between two strings.
 *
 * With `max`, the computation stops as soon as every cell of a DP row
 * exceeds `max` (the distance can only grow from there) and returns `max + 1`.
 * Without it, the exact distance is returned.
 */
export function levenshtein(a: string, b: string, max = Infinity): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > max) return max + 1;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] !== b[j - 1] ? 1 : 0),
      );
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return Math.min(prev[n]!, max + 1);
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
    const d = levenshtein(input, candidate, bestDist - 1);
    if (d < bestDist) { bestDist = d; best = candidate; }
  }
  return best;
}
