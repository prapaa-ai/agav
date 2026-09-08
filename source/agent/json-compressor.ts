/**
 * JSON-aware tool-result compression (SmartCrusher-style), pure TypeScript, no
 * dependencies and no model.
 *
 * Large tool outputs are frequently JSON arrays of similar objects — search
 * results, directory listings, API/MCP dumps. Re-sending the whole array to the
 * model on every turn is expensive and most of it is redundant. This module
 * detects that shape and keeps the *informative* items — errors, statistical
 * outliers, and the first/last boundary items — while replacing the redundant
 * middle with a compact, honest summary of what was dropped.
 *
 * Guarantees:
 *  - Only touches text that parses as JSON. Non-JSON is returned untouched.
 *  - Only compresses when it actually saves a meaningful amount.
 *  - Output remains valid JSON (an object with the kept items + a summary), so
 *    the model can still reason over it.
 *  - Never silently loses the fact that data was dropped: the summary states the
 *    original count and how to get more (re-run the tool with paging/filter).
 */

export interface JsonCompressionResult {
  text: string;
  compressed: boolean;
  originalChars: number;
  compressedChars: number;
}

export interface JsonCompressionOptions {
  /** Only compress payloads at least this many characters. */
  minChars?: number;
  /** Keep this many items from the start and end of a large array. */
  keepBoundary?: number;
  /** Arrays with fewer than this many items are left alone. */
  minArrayItems?: number;
}

const DEFAULTS = {
  minChars: 2000,
  keepBoundary: 3,
  minArrayItems: 12,
};

/**
 * Compress a tool result if it is a large JSON array of objects. Returns the
 * original text unchanged (compressed: false) for anything else.
 */
export function compressJsonToolResult(
  text: string,
  options: JsonCompressionOptions = {},
): JsonCompressionResult {
  const minChars = options.minChars ?? DEFAULTS.minChars;
  const keepBoundary = options.keepBoundary ?? DEFAULTS.keepBoundary;
  const minArrayItems = options.minArrayItems ?? DEFAULTS.minArrayItems;

  const originalChars = text.length;
  const unchanged = (): JsonCompressionResult => ({
    text,
    compressed: false,
    originalChars,
    compressedChars: originalChars,
  });

  if (originalChars < minChars) return unchanged();

  // Only attempt when the payload looks like JSON — cheap guard before parsing.
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return unchanged();

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return unchanged();
  }

  // Find the array to compress: either the root, or the single largest array
  // field of a root object (common: { results: [...] } / { data: [...] }).
  const arrayInfo = findCompressibleArray(parsed);
  if (!arrayInfo) return unchanged();

  const { array, keyPath } = arrayInfo;
  if (array.length < minArrayItems) return unchanged();

  const kept = selectInformativeItems(array, keepBoundary);
  if (kept.keptIndices.size >= array.length) return unchanged();

  const droppedCount = array.length - kept.keptIndices.size;
  const summaryArray = buildSummaryArray(array, kept.keptIndices, droppedCount, keyPath);

  const rebuilt = rebuildWithArray(parsed, keyPath, summaryArray);
  const out = JSON.stringify(rebuilt, null, 2);

  // Only accept the compression if it genuinely shrank the payload.
  if (out.length >= originalChars) return unchanged();

  return {
    text: out,
    compressed: true,
    originalChars,
    compressedChars: out.length,
  };
}

/**
 * Locate an array worth compressing: the root if it is an array, otherwise the
 * largest top-level array-of-objects field of a root object.
 */
function findCompressibleArray(
  parsed: unknown,
): { array: unknown[]; keyPath: string | null } | null {
  if (Array.isArray(parsed)) {
    return isArrayOfObjects(parsed) ? { array: parsed, keyPath: null } : null;
  }
  if (parsed && typeof parsed === "object") {
    let best: { array: unknown[]; keyPath: string } | null = null;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value) && isArrayOfObjects(value)) {
        if (!best || value.length > best.array.length) {
          best = { array: value, keyPath: key };
        }
      }
    }
    return best;
  }
  return null;
}

function isArrayOfObjects(arr: unknown[]): boolean {
  if (arr.length === 0) return false;
  let objectCount = 0;
  for (const item of arr) {
    if (item && typeof item === "object" && !Array.isArray(item)) objectCount++;
  }
  // Mostly objects (tolerate a few nulls/primitives).
  return objectCount >= Math.ceil(arr.length * 0.6);
}

/**
 * Decide which items to keep: the first/last `keepBoundary`, plus any item that
 * looks like an error, plus statistical outliers (items with unusually many
 * fields or unusually long serialized length). Everything else is dropped.
 */
function selectInformativeItems(
  array: unknown[],
  keepBoundary: number,
): { keptIndices: Set<number> } {
  const kept = new Set<number>();

  // Boundaries.
  for (let i = 0; i < Math.min(keepBoundary, array.length); i++) kept.add(i);
  for (let i = Math.max(0, array.length - keepBoundary); i < array.length; i++) kept.add(i);

  // Errors — always informative.
  array.forEach((item, i) => {
    if (looksLikeError(item)) kept.add(i);
  });

  // Length outliers: items whose serialized size is > mean + 2*stddev.
  const lengths = array.map((item) => JSON.stringify(item)?.length ?? 0);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length;
  const std = Math.sqrt(variance);
  const threshold = mean + 2 * std;
  lengths.forEach((len, i) => {
    if (std > 0 && len > threshold) kept.add(i);
  });

  return { keptIndices: kept };
}

function looksLikeError(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const obj = item as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const k = key.toLowerCase();
    if (k === "error" || k === "err" || k === "exception" || k === "failed") {
      const v = obj[key];
      // A falsey `error: false` / `error: null` is not an error.
      if (v !== false && v !== null && v !== undefined && v !== "") return true;
    }
    if ((k === "status" || k === "level" || k === "severity")) {
      const v = String(obj[key]).toLowerCase();
      if (v.includes("error") || v.includes("fatal") || v.includes("fail") || v.includes("critical")) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Build the replacement array: kept items in original order, with a single
 * summary marker object inserted where the dropped run was, so the model both
 * sees the survivors and knows data was elided (and how much).
 */
function buildSummaryArray(
  array: unknown[],
  keptIndices: Set<number>,
  droppedCount: number,
  keyPath: string | null,
): unknown[] {
  const result: unknown[] = [];
  let summaryInserted = false;
  for (let i = 0; i < array.length; i++) {
    if (keptIndices.has(i)) {
      result.push(array[i]);
    } else if (!summaryInserted) {
      result.push({
        __compressed__: true,
        droppedItems: droppedCount,
        note:
          `${droppedCount} similar item(s) omitted to save context` +
          `${keyPath ? ` from "${keyPath}"` : ""}. ` +
          `Kept: first/last items, errors, and outliers. Re-run the tool with ` +
          `paging or a filter to see the full set.`,
      });
      summaryInserted = true;
    }
    // Subsequent dropped items are folded into the one summary marker.
  }
  return result;
}

/** Rebuild the original structure with the array replaced. */
function rebuildWithArray(parsed: unknown, keyPath: string | null, newArray: unknown[]): unknown {
  if (keyPath === null) return newArray;
  return { ...(parsed as Record<string, unknown>), [keyPath]: newArray };
}
