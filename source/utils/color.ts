const _useColor = (() => {
  if (process.env["NO_COLOR"] !== undefined) return false;
  if (process.env["TERM"] === "dumb") return false;
  if (!process.stderr.isTTY) return false;
  return true;
})();

export function shouldUseColor(): boolean {
  return _useColor;
}

export function dim(text: string): string {
  return _useColor ? `\x1b[2m${text}\x1b[0m` : text;
}

export const icons = _useColor
  ? { pending: "⏳", success: "✓", error: "✗", warning: "⚠" }
  : { pending: "...", success: "ok", error: "FAIL", warning: "!!" };
