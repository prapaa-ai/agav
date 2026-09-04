import { wrapToWidth } from "./wrap-text.js";
import type { DetectedTarget } from "./detect-targets.js";
import type { OpenRef } from "./open-ref.js";

/** One visual line's worth of runs, ready for `ClickableLine`. */
export interface LineRunSpec {
  text: string;
  targetId?: string;
  color?: string;
  backgroundColor?: string;
  underline?: boolean;
  dimColor?: boolean;
  bold?: boolean;
}

/**
 * Split plain (unstyled) `text` into wrapped visual lines, each expressed as
 * a list of runs — some plain, some carrying a `targetId` for a detected
 * target that overlaps that span of the line.
 *
 * `targets` are offsets into the *original* `text`, not into any individual
 * wrapped line — this function is responsible for translating each target's
 * `[start, end)` range across the wrap boundaries, including targets that
 * straddle a wrap (both halves get the same `targetId`, so either one opens
 * the same thing).
 *
 * Deliberately operates on plain text: wrapping and slicing styled markdown
 * output is handled separately via `sliceStyled`/`wrapStyled` by the caller
 * for assistant messages; this function is for the simpler unstyled case
 * (system messages, or callers that pre-render color per run instead).
 */
export function wrapTextToRuns(
  text: string,
  width: number,
  targets: DetectedTarget[],
  makeTargetId: (target: DetectedTarget) => string,
  style: { color?: string; underline?: boolean } = {},
  plainRunStyle: { color?: string; backgroundColor?: string; dimColor?: boolean; bold?: boolean } = {},
): LineRunSpec[][] {
  if (targets.length === 0) {
    return wrapToWidth(text, width).map((line) => [{ text: line, ...plainRunStyle }]);
  }

  // Map each character of `text` to the target (if any) that covers it, so a
  // wrap that lands anywhere — including mid-target — carries the right id
  // on both sides.
  const owner: (DetectedTarget | null)[] = new Array(text.length).fill(null);
  for (const target of targets) {
    for (let i = target.start; i < target.end && i < text.length; i++) {
      owner[i] = target;
    }
  }

  const lines = wrapToWidth(text, width);
  const result: LineRunSpec[][] = [];
  let cursor = 0;

  for (const line of lines) {
    const runs: LineRunSpec[] = [];
    // `wrapToWidth` drops the separating space between words when it breaks a
    // line, so re-sync `cursor` to the next occurrence of this line's content
    // rather than assuming a fixed-width advance. Lines are produced in order
    // and never overlap, so searching forward from `cursor` is safe.
    let lineStart = text.indexOf(line, cursor);
    if (lineStart === -1) lineStart = cursor;

    let i = 0;
    while (i < line.length) {
      const absPos = lineStart + i;
      const target = owner[absPos] ?? null;
      let j = i;
      while (j < line.length && (owner[lineStart + j] ?? null) === target) j++;
      const chunk = line.slice(i, j);
      if (target) {
        runs.push({ text: chunk, targetId: makeTargetId(target), color: style.color, underline: style.underline });
      } else {
        runs.push({ text: chunk, ...plainRunStyle });
      }
      i = j;
    }

    result.push(runs.length > 0 ? runs : [{ text: "", ...plainRunStyle }]);
    cursor = lineStart + line.length;
  }

  return result;
}

/** Convenience wrapper that encodes each `DetectedTarget` as an `OpenRef` string id. */
export function targetToRefId(target: DetectedTarget, encode: (ref: OpenRef) => string): string {
  if (target.kind === "url") return encode({ kind: "url", url: target.text });
  return encode({ kind: "path", absPath: target.absPath!, line: target.line, col: target.col });
}
