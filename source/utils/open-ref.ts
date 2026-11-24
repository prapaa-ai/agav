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
  if (ref.kind !== "path") return JSON.stringify(ref);
  // JSON would encode non-finite coordinates as null, invalidating the ref.
  const { line, col, ...path } = ref;
  return JSON.stringify({
    ...path,
    line: isOptionalFiniteNumber(line) ? line : undefined,
    col: isOptionalFiniteNumber(col) ? col : undefined,
  });
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isOpenRef(value: unknown): value is OpenRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  switch (ref.kind) {
    case "attachment":
      return typeof ref.id === "number" && Number.isSafeInteger(ref.id) && ref.id > 0;
    case "url":
      return typeof ref.url === "string" && ref.url.trim().length > 0;
    case "path":
      return (
        typeof ref.absPath === "string" && ref.absPath.trim().length > 0 &&
        isOptionalFiniteNumber(ref.line) &&
        isOptionalFiniteNumber(ref.col)
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
