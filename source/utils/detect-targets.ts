import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isWithinRoot } from "./path-guard.js";

export type DetectedTargetKind = "url" | "path";

export interface DetectedTarget {
  kind: DetectedTargetKind;
  /** The exact substring matched in the source text — includes any `:line:col` suffix for a path. */
  text: string;
  /** Start/end offsets (in visible characters) within the text that was scanned. */
  start: number;
  end: number;
  /** Resolved absolute path, only present for `kind: "path"`. */
  absPath?: string;
  /** `:line[:col]` suffix captured after a path, if any. */
  line?: number;
  col?: number;
  /**
   * For `kind: "path"` only — the path portion alone, with no `:line:col`
   * suffix. This, not `text`, is what gets resolved and stat'd: `text` is the
   * whole matched substring (including a trailing `:12:5`), and no real file
   * is ever named that literally.
   */
  pathOnly?: string;
}

/**
 * Matches an http(s) URL. Deliberately excludes trailing punctuation that is
 * almost always sentence punctuation rather than part of the URL
 * (`.`, `,`, `;`, `:`, `!`, `?`) as well as closing brackets/quotes that are
 * more likely to be prose delimiters than part of the link.
 */
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]*[^\s<>"'`)\]}.,;:!?]/g;

/**
 * Matches a project-relative file path mentioned in prose.
 *
 * Requires a `/` separator — bare `package.json` is deliberately *not*
 * linkified; unqualified filenames are constant in ordinary prose and
 * linkifying all of them would be noise. Requires a letter-initial 1-10
 * character extension, which kills numeric-looking false positives like
 * `3.5/2.1`, `2024/01/02`, `50/50`, `linux/amd64`. `(?<![\w@/.-])` avoids
 * matching the tail of an email address or the middle of a longer path
 * fragment; the trailing `(?![\w/])` avoids matching a bare directory that
 * happens to precede more path-like characters.
 */
const PATH_RE = /(?<![\w@/.-])((?:\.{1,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z][\w]{0,9})(?::(\d+))?(?::(\d+))?(?![\w/])/g;

/** Replace every URL match with spaces of the same length, so path matching cannot see into one. */
function blankUrls(text: string, urlMatches: { start: number; end: number }[]): string {
  if (urlMatches.length === 0) return text;
  const chars = [...text];
  for (const { start, end } of urlMatches) {
    for (let i = start; i < end; i++) chars[i] = " ";
  }
  return chars.join("");
}

/** Find every URL and candidate path in `text`, without validating paths against the filesystem yet. */
function findCandidates(text: string): DetectedTarget[] {
  const targets: DetectedTarget[] = [];

  const urlMatches: { start: number; end: number }[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    urlMatches.push({ start, end });
    targets.push({ kind: "url", text: match[0], start, end });
  }

  const blanked = blankUrls(text, urlMatches);
  for (const match of blanked.matchAll(PATH_RE)) {
    const start = match.index ?? 0;
    const full = match[0];
    targets.push({
      kind: "path",
      text: full,
      start,
      end: start + full.length,
      pathOnly: match[1],
      line: match[2] ? Number(match[2]) : undefined,
      col: match[3] ? Number(match[3]) : undefined,
    });
  }

  targets.sort((a, b) => a.start - b.start);
  return targets;
}

/** Per-message cache of validated targets, so re-render never re-detects. */
const detectionCache = new Map<string, DetectedTarget[]>();
const DETECTION_CACHE_MAX = 300;

/**
 * Detect URLs and existing project-relative file paths in `text`, validating
 * each path candidate against the filesystem before it is reported.
 *
 * A path candidate is only reported if it resolves inside `root` and exists
 * on disk. Anything that fails validation is silently dropped — never
 * reported as invalid — so the caller can render it as ordinary text with no
 * further bookkeeping: the affordance never lies about what it can open.
 *
 * Cached by `cacheKey` (typically a message id), since detection runs
 * filesystem stats and must not repeat per render.
 */
export async function detectTargets(text: string, root: string, cacheKey?: string): Promise<DetectedTarget[]> {
  if (cacheKey) {
    const cached = detectionCache.get(cacheKey);
    if (cached) return cached;
  }

  const candidates = findCandidates(text);
  const validated: DetectedTarget[] = [];

  for (const candidate of candidates) {
    if (candidate.kind === "url") {
      try {
        const parsed = new URL(candidate.text);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      } catch {
        continue;
      }
      validated.push(candidate);
      continue;
    }

    // kind === "path"
    try {
      const absPath = resolve(root, candidate.pathOnly ?? candidate.text);
      if (!isWithinRoot(root, absPath)) continue;
      await stat(absPath);
      validated.push({ ...candidate, absPath });
    } catch {
      // Missing file, traversal outside root, or any other stat failure —
      // not clickable, rendered as plain text.
    }
  }

  if (cacheKey) {
    if (detectionCache.size >= DETECTION_CACHE_MAX) {
      const firstKey = detectionCache.keys().next().value;
      if (firstKey !== undefined) detectionCache.delete(firstKey);
    }
    detectionCache.set(cacheKey, validated);
  }

  return validated;
}

/** Clear the detection cache — used in tests and on session reset. */
export function clearDetectionCache(): void {
  detectionCache.clear();
}
