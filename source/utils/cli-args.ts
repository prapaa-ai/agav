/**
 * Parse a positive safe-integer iteration budget, shared by `--max-turns N`
 * and `-c maxIterations=N` so the two flags always agree. Writes an actionable
 * error and exits 1 on bad input; `flag`/`usage` customize the message.
 */
export function parseMaxTurns(
  raw: string,
  flag = "--max-turns",
  usage = `Use ${flag} N or ${flag}=N.`,
): number {
  const value = raw.trim();
  const n = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(n) || n <= 0) {
    process.stderr.write(`Error: ${flag} must be a positive safe integer (1–9007199254740991). ${usage}\n`);
    process.exit(1);
  }
  return n;
}
