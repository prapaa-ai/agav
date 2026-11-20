/**
 * A reference to something clickable in the transcript or the prompt: an
 * attachment tile, a detected URL, or a detected file path.
 *
 * `ClickableLine` only carries an opaque string id per run, so a ref is
 * serialized to travel through it and parsed back out in the click handler —
 * see `encodeOpenRef` / `decodeOpenRef`.
 */
export type OpenRef =
  | { kind: "attachment"; id: number }
  | { kind: "url"; url: string }
  | { kind: "path"; absPath: string; line?: number; col?: number };

export function encodeOpenRef(ref: OpenRef): string {
  return JSON.stringify(ref);
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

function isOpenRef(value: unknown): value is OpenRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  switch (ref.kind) {
    case "attachment":
      return typeof ref.id === "number";
    case "url":
      return typeof ref.url === "string";
    case "path":
      return (
        typeof ref.absPath === "string" &&
        isOptionalNumber(ref.line) &&
        isOptionalNumber(ref.col)
      );
    default:
      return false;
  }
}

export function decodeOpenRef(key: string): OpenRef | null {
  try {
    const parsed: unknown = JSON.parse(key);
    if (isOpenRef(parsed)) return parsed;
  } catch {
    // Not a ref — a run with a plain string id, or malformed input.
  }
  return null;
}
