import { stripVTControlCharacters } from "node:util";

const REDACTED = "***REDACTED***";
const CREDENTIAL_KEY = /^(?:[a-z0-9]+_)*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|client[_-]?secret|authorization)$/i;
const CREDENTIAL_ASSIGNMENT = /(\b(?:[a-z0-9]+_)*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|client[_-]?secret|authorization)\b["']?[ \t]*[:=][ \t]*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|Bearer[ \t]+[a-z0-9._~+\/-]+=*|[^\s,;}\])"'`]+)/gi;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Best-effort export-only redaction. Never traverses config or reads credentials. */
export function createExportRedactor(home: string, platform: NodeJS.Platform = process.platform) {
  const windows = platform === "win32";
  const normalizedHome = home.replace(windows ? /[\\/]+$/ : /\/+$/, "");
  // A filesystem root is not an identifying home prefix.
  const usableHome = normalizedHome && !(windows && /^[a-z]:$/i.test(normalizedHome));
  const homePattern = usableHome
    ? new RegExp(
      `(^|[\\s"'\x60=:(\\[{>])${windows
        ? normalizedHome.split(/[\\/]/).map(escapeRegex).join("[\\\\/]+")
        : escapeRegex(normalizedHome)}(?=$|[${windows ? "\\\\/" : "/"}\\s"'\x60)\\]},:;!?<>])`,
      windows ? "gi" : "g",
    )
    : undefined;

  function text(input: string): string {
    let output = stripVTControlCharacters(input)
      .replace(CREDENTIAL_ASSIGNMENT, (_match, prefix: string, value: string) => {
        const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
        return `${prefix}${quote}${REDACTED}${quote}`;
      })
      .replace(/\bBearer[ \t]+[a-z0-9._~+\/-]+=*/gi, `Bearer ${REDACTED}`)
      .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[a-z0-9_-]{8,}/gi, REDACTED);
    if (homePattern) output = output.replace(homePattern, "$1~");
    return output;
  }

  function value(input: unknown, key?: string): unknown {
    if (typeof input === "string") {
      return key && CREDENTIAL_KEY.test(key) && input.length > 0 ? REDACTED : text(input);
    }
    if (Array.isArray(input)) return input.map((item) => value(item, key));
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).map(([name, item]) => [name, value(item, name)]));
    }
    return input;
  }

  return { text, value };
}
