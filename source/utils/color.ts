/**
 * Whether to emit ANSI color, in order:
 * 1. NO_COLOR set (any value) → off
 * 2. FORCE_COLOR set → off for "", "0" or "false", otherwise on (even without a TTY or with TERM=dumb)
 * 3. TERM=dumb → off
 * 4. otherwise on only when stderr is a TTY
 */
export function resolveUseColor(env: NodeJS.ProcessEnv, isTTY: boolean | undefined): boolean {
  if (env["NO_COLOR"] !== undefined) return false;
  const force = env["FORCE_COLOR"];
  if (force !== undefined) return !["", "0", "false"].includes(force.trim().toLowerCase());
  if (env["TERM"] === "dumb") return false;
  return Boolean(isTTY);
}

const _useColor = resolveUseColor(process.env, process.stderr.isTTY);

export function shouldUseColor(): boolean {
  return _useColor;
}

export function dim(text: string): string {
  return _useColor ? `\x1b[2m${text}\x1b[0m` : text;
}

export const icons = _useColor
  ? { pending: "⏳", success: "✓", error: "✗", warning: "⚠" }
  : { pending: "...", success: "ok", error: "FAIL", warning: "!!" };
