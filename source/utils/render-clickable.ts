import { wrapStyled, sliceStyled } from "../components/markdown-text.js";
import { stripAnsi } from "./wrap-text.js";
import type { DetectedTarget } from "./detect-targets.js";
import type { LineRunSpec } from "./wrap-runs.js";

/**
 * Wrap an already-markdown-rendered (ANSI-styled) string to `width` columns,
 * and turn every detected target's exact matched text into its own clickable
 * run — including a target whose rendered text is split across a wrap
 * boundary, whose two halves both resolve to the same target.
 *
 * Targets were detected against the *raw* (pre-markdown) text, so a target is
 * only made clickable here if its literal substring still appears in the
 * rendered text — true for the overwhelming majority of URLs and file paths,
 * since markdown syntax rarely alters them, and simply falls back to plain
 * text (never lying about the affordance) on the rare case it doesn't.
 *
 * Occurrences are located once, against the *whole* rendered text — not
 * line-by-line. A per-line search only ever finds a target that happens to
 * land entirely within one wrapped line; a longer path or URL that gets
 * broken mid-token by the wrap (exactly the case `wrapStyled` hard-breaks) has
 * no single line containing its complete substring, so it silently rendered
 * as plain, unclickable text — the inconsistency where only *some*
 * agent-mentioned paths were clickable. Building one ownership map over the
 * whole text before wrapping, then re-deriving where each wrapped line falls
 * within it, makes a straddling target's ownership span the boundary the same
 * way `wrapTextToRuns` already does for plain (non-styled) text.
 *
 * Offsets are matched by indexOf on ANSI-stripped text (UTF-16 code units),
 * then converted to grapheme offsets separately for each wrapped line before
 * slicing styled output. This keeps targets after emoji or combining text
 * aligned with `sliceStyled`, whose offsets are grapheme based.
 */
export function buildClickableLines(
  styledText: string,
  width: number,
  targets: DetectedTarget[],
  makeTargetId: (target: DetectedTarget) => string,
  style: { color?: string; underline?: boolean },
  plainRunStyle: { dimColor?: boolean } = {},
): LineRunSpec[][] {
  const wrapped = wrapStyled(styledText, width);
  if (targets.length === 0) return wrapped.map((line) => [{ text: line, ...plainRunStyle }]);

  const fullVisible = stripAnsi(styledText);
  const graphemeOffsetAt = (text: string, codeUnitOffset: number) => {
    let offset = 0;
    for (const { index } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
      if (index >= codeUnitOffset) break;
      offset++;
    }
    return offset;
  };

  type Occurrence = { start: number; end: number; target: DetectedTarget };
  const occurrences: Occurrence[] = [];
  for (const target of targets) {
    let idx = fullVisible.indexOf(target.text);
    while (idx !== -1) {
      occurrences.push({ start: idx, end: idx + target.text.length, target });
      idx = fullVisible.indexOf(target.text, idx + target.text.length);
    }
  }

  if (occurrences.length === 0) return wrapped.map((line) => [{ text: line, ...plainRunStyle }]);

  occurrences.sort((a, b) => a.start - b.start);
  const merged: Occurrence[] = [];
  let lastEnd = -1;
  for (const occurrence of occurrences) {
    if (occurrence.start >= lastEnd) {
      merged.push(occurrence);
      lastEnd = occurrence.end;
    }
  }

  // Map every visible position of the *whole* rendered text to the target (if
  // any) that owns it, so a wrap that lands anywhere — including mid-target —
  // carries the right id on both sides.
  const owner: (DetectedTarget | null)[] = new Array(fullVisible.length).fill(null);
  for (const occurrence of merged) {
    for (let i = occurrence.start; i < occurrence.end && i < fullVisible.length; i++) {
      owner[i] = occurrence.target;
    }
  }

  let cursor = 0;
  return wrapped.map((line) => {
    const visibleLine = stripAnsi(line);
    // `wrapStyled` drops the separating space between words when it breaks a
    // line, so re-sync to the next occurrence of this line's visible content
    // rather than assuming a fixed-width advance — the same trick
    // `wrapTextToRuns` uses for plain text. Lines are produced in order and
    // never overlap, so searching forward from `cursor` is safe.
    let lineStart = fullVisible.indexOf(visibleLine, cursor);
    if (lineStart === -1) lineStart = cursor;
    cursor = lineStart + visibleLine.length;

    const runs: LineRunSpec[] = [];
    let i = 0;
    while (i < visibleLine.length) {
      const target = owner[lineStart + i] ?? null;
      let j = i;
      while (j < visibleLine.length && (owner[lineStart + j] ?? null) === target) j++;
      const chunk = sliceStyled(line, graphemeOffsetAt(visibleLine, i), graphemeOffsetAt(visibleLine, j));
      if (target) {
        runs.push({ text: chunk, targetId: makeTargetId(target), color: style.color, underline: style.underline });
      } else {
        runs.push({ text: chunk, ...plainRunStyle });
      }
      i = j;
    }

    return runs.length > 0 ? runs : [{ text: line, ...plainRunStyle }];
  });
}
