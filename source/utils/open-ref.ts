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

export function decodeOpenRef(key: string): OpenRef | null {
  try {
    const parsed = JSON.parse(key);
    if (parsed && typeof parsed === "object" && typeof parsed.kind === "string") {
      return parsed as OpenRef;
    }
  } catch {
    // Not a ref — a run with a plain string id, or malformed input.
  }
  return null;
}
