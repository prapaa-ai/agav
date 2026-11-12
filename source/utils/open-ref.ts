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
    if (parsed && typeof parsed === "object") {
      switch (parsed.kind) {
        case "attachment":
          return typeof parsed.id === "number" ? { kind: "attachment", id: parsed.id } : null;
        case "url":
          return typeof parsed.url === "string" ? { kind: "url", url: parsed.url } : null;
        case "path":
          if (typeof parsed.absPath !== "string") return null;
          return {
            kind: "path",
            absPath: parsed.absPath,
            ...(typeof parsed.line === "number" ? { line: parsed.line } : {}),
            ...(typeof parsed.col === "number" ? { col: parsed.col } : {}),
          };
      }
    }
  } catch {
    // Not a ref — a run with a plain string id, or malformed input.
  }
  return null;
}
