import { stat, unlink, writeFile, rename } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { computeDiff, type DiffLine } from "./diff.js";

export interface EditHunk {
  old_string: string;
  new_string: string;
}

export type MatchStrategy =
  | "exact"
  | "line-ending"
  | "trailing-whitespace"
  | "indentation"
  | "blank-line-tolerant"
  | "unicode-normalized"
  | "fuzzy";

export interface MatchedHunk {
  originalIndex: number;
  start: number; // offset in originalContent
  end: number;   // offset in originalContent
  startLine: number; // 1-based line number in originalContent
  endLine: number;   // 1-based line number in originalContent
  matchedText: string;
  newText: string;
  strategy: MatchStrategy;
}

export interface NearMissDiagnostic {
  line: number;
  similarity: number;
  expectedSnippet: string;
  foundSnippet: string;
  differences: string;
}

export interface MatchFailure {
  success: false;
  reason: "empty_old_string" | "not_found" | "ambiguous" | "overlapping" | "no_change";
  message: string;
  hunkIndex?: number;
  occurrences?: number;
  matchingLines?: number[];
  nearMiss?: NearMissDiagnostic;
}

export interface MatchSuccess {
  success: true;
  matches: MatchedHunk[];
  updatedContent: string;
  diffLines: DiffLine[];
}

export type EditResult = MatchSuccess | MatchFailure;

// ==========================================
// 1. Line Ending Detection & Mapping Helpers
// ==========================================

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfCount = (content.match(/\r\n/g) || []).length;
  const lfOnlyCount = (content.match(/(?<!\r)\n/g) || []).length;
  return crlfCount > lfOnlyCount ? "\r\n" : "\n";
}

export function adaptLineEndings(text: string, targetEnding: "\r\n" | "\n"): string {
  if (targetEnding === "\r\n") {
    return text.replace(/\r?\n/g, "\r\n");
  }
  return text.replace(/\r\n/g, "\n");
}

/**
 * Builds a lookup table mapping each character index in LF-normalized space
 * to the corresponding character index in the original raw string.
 */
export function buildLfToOriginalMap(original: string): number[] {
  const map: number[] = [];
  let origIdx = 0;
  const origLen = original.length;

  while (origIdx < origLen) {
    map.push(origIdx);
    if (original[origIdx] === "\r" && origIdx + 1 < origLen && original[origIdx + 1] === "\n") {
      origIdx += 2;
    } else {
      origIdx += 1;
    }
  }
  map.push(origIdx); // boundary past the last character
  return map;
}

export function mapLfRangeToOriginal(
  original: string,
  lfMap: number[],
  lfStart: number,
  lfLength: number,
): { start: number; end: number; length: number; matchedText: string } {
  const start = lfMap[lfStart] ?? original.length;
  const end = lfMap[lfStart + lfLength] ?? original.length;
  return {
    start,
    end,
    length: end - start,
    matchedText: original.slice(start, end),
  };
}

export function getLineNumber(content: string, charOffset: number): number {
  if (charOffset <= 0) return 1;
  const slice = content.slice(0, Math.min(charOffset, content.length));
  return (slice.match(/\n/g) || []).length + 1;
}

// ==========================================
// 2. Unicode & Text Normalization
// ==========================================

export function normalizeUnicode(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

// ==========================================
// 3. String Metrics & Levenshtein
// ==========================================

export function levenshteinDistance(s1: string, s2: string): number {
  if (s1 === s2) return 0;
  if (s1.length === 0) return s2.length;
  if (s2.length === 0) return s1.length;

  const m = s1.length;
  const n = s2.length;

  let prevRow = new Array<number>(n + 1);
  let currRow = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) {
    prevRow[j] = j;
  }

  for (let i = 1; i <= m; i++) {
    currRow[0] = i;
    const c1 = s1.charCodeAt(i - 1);

    for (let j = 1; j <= n; j++) {
      const c2 = s2.charCodeAt(j - 1);
      const cost = c1 === c2 ? 0 : 1;
      currRow[j] = Math.min(
        currRow[j - 1]! + 1,      // insertion
        prevRow[j]! + 1,          // deletion
        prevRow[j - 1]! + cost,   // substitution
      );
    }

    const temp = prevRow;
    prevRow = currRow;
    currRow = temp;
  }

  return prevRow[n]!;
}

export function calculateSimilarity(s1: string, s2: string): number {
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshteinDistance(s1, s2);
  return Math.max(0, 1.0 - dist / maxLen);
}

function truncateString(str: string, maxLen = 140): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "...";
}

function describeDifferences(expected: string, found: string): string {
  const expLines = expected.split(/\r?\n/);
  const foundLines = found.split(/\r?\n/);

  if (expLines.length === foundLines.length && expLines.length > 0) {
    const diffs: string[] = [];
    for (let i = 0; i < expLines.length; i++) {
      if (expLines[i] !== foundLines[i]) {
        diffs.push(`line ${i + 1}: expected "${truncateString(expLines[i]!, 60)}" but found "${truncateString(foundLines[i]!, 60)}"`);
        if (diffs.length >= 3) break;
      }
    }
    if (diffs.length > 0) {
      return diffs.join("; ");
    }
  }

  if (expected.length !== found.length) {
    return `length difference (${expected.length} chars expected vs ${found.length} chars found)`;
  }
  return `minor character variations`;
}

// ==========================================
// 4. Single Hunk Matcher (4-Layer Strategy)
// ==========================================

interface InternalMatch {
  start: number;
  end: number;
  matchedText: string;
  newText: string;
  strategy: MatchStrategy;
}

type SingleMatchResult =
  | { found: true; match: InternalMatch }
  | { found: false; failure: MatchFailure };

function findExactOccurrences(content: string, search: string): number[] {
  if (!search) return [];
  const indices: number[] = [];
  let pos = 0;
  while ((pos = content.indexOf(search, pos)) !== -1) {
    indices.push(pos);
    pos += 1;
  }
  return indices;
}

export function matchSingleHunk(
  originalContent: string,
  hunk: EditHunk,
  hunkIndex = 0,
): SingleMatchResult {
  const oldString = hunk.old_string;
  const newString = hunk.new_string;

  if (oldString.length === 0) {
    return {
      found: false,
      failure: {
        success: false,
        reason: "empty_old_string",
        hunkIndex,
        message: hunkIndex === 0 && !("edits" in hunk)
          ? "old_string cannot be empty"
          : `edits[${hunkIndex}].old_string cannot be empty`,
      },
    };
  }

  if (originalContent.length === 0) {
    return {
      found: false,
      failure: {
        success: false,
        reason: "not_found",
        hunkIndex,
        message: `File is empty. Cannot match old_string.`,
      },
    };
  }

  const nativeEnding = detectLineEnding(originalContent);

  // --------------------------------------------------------------------------
  // LAYER 1: Raw Exact Match
  // --------------------------------------------------------------------------
  const exactIndices = findExactOccurrences(originalContent, oldString);
  if (exactIndices.length === 1) {
    const start = exactIndices[0]!;
    return {
      found: true,
      match: {
        start,
        end: start + oldString.length,
        matchedText: oldString,
        newText: newString,
        strategy: "exact",
      },
    };
  }
  if (exactIndices.length > 1) {
    const lines = exactIndices.map((idx) => getLineNumber(originalContent, idx));
    return {
      found: false,
      failure: {
        success: false,
        reason: "ambiguous",
        hunkIndex,
        occurrences: exactIndices.length,
        matchingLines: lines,
        message: `Found ${exactIndices.length} exact occurrences of old_string at line${lines.length > 1 ? "s" : ""} ${lines.join(", ")}. Provide more surrounding context to make it unique.`,
      },
    };
  }

  // Prepare normalized LF views and character maps for Layers 2-4
  const contentLF = originalContent.replace(/\r\n/g, "\n");
  const oldLF = oldString.replace(/\r\n/g, "\n");
  const newLF = newString.replace(/\r\n/g, "\n");
  const lfMap = buildLfToOriginalMap(originalContent);

  // --------------------------------------------------------------------------
  // LAYER 2: Line-Ending Normalization (CRLF vs LF)
  // --------------------------------------------------------------------------
  const lfIndices = findExactOccurrences(contentLF, oldLF);
  if (lfIndices.length === 1) {
    const lfStart = lfIndices[0]!;
    const mapped = mapLfRangeToOriginal(originalContent, lfMap, lfStart, oldLF.length);
    return {
      found: true,
      match: {
        start: mapped.start,
        end: mapped.end,
        matchedText: mapped.matchedText,
        newText: adaptLineEndings(newLF, nativeEnding),
        strategy: "line-ending",
      },
    };
  }
  if (lfIndices.length > 1) {
    const lines = lfIndices.map((idx) => getLineNumber(contentLF, idx));
    return {
      found: false,
      failure: {
        success: false,
        reason: "ambiguous",
        hunkIndex,
        occurrences: lfIndices.length,
        matchingLines: lines,
        message: `Found ${lfIndices.length} occurrences of old_string after line-ending normalization at lines ${lines.join(", ")}. Provide more surrounding context to make it unique.`,
      },
    };
  }

  // --------------------------------------------------------------------------
  // LAYER 3: Whitespace & Indentation Tolerant Matching
  // --------------------------------------------------------------------------
  const fileLines = contentLF.split("\n");
  const searchLines = oldLF.split("\n");

  // Helper to compute LF offsets from line range
  const computeLfRangeFromLines = (startLineIdx: number, endLineIdx: number) => {
    let startOffset = 0;
    for (let i = 0; i < startLineIdx; i++) {
      startOffset += fileLines[i]!.length + 1;
    }
    let endOffset = startOffset;
    for (let i = startLineIdx; i < endLineIdx; i++) {
      endOffset += fileLines[i]!.length + (i < fileLines.length - 1 ? 1 : 0);
    }
    return { startOffset, length: endOffset - startOffset };
  };

  // Helper to adapt indentation of replacement text if model followed old_string's indentation
  const adaptIndentation = (matchedFileBlock: string[], searchBlock: string[], rawNewText: string): string => {
    if (matchedFileBlock.length === 0 || searchBlock.length === 0) return rawNewText;
    const fileLead = (matchedFileBlock[0]!.match(/^[ \t]+/) || [""])[0]!;
    const searchLead = (searchBlock[0]!.match(/^[ \t]+/) || [""])[0]!;

    if (fileLead === searchLead) return rawNewText;

    // Check if new_string lines follow searchLead
    const newLines = rawNewText.split(/\r?\n/);
    const followsSearchLead = newLines.some((l) => l.startsWith(searchLead));
    if (!followsSearchLead) return rawNewText;

    // Replace searchLead with fileLead
    const adapted = newLines.map((line) => {
      if (line.startsWith(searchLead)) {
        return fileLead + line.slice(searchLead.length);
      }
      return line;
    });

    return adapted.join(nativeEnding);
  };

  // 3A. Trailing whitespace tolerant matching (trimEnd)
  if (searchLines.length <= fileLines.length) {
    const trailingMatches: number[] = [];
    for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
      let matches = true;
      for (let k = 0; k < searchLines.length; k++) {
        if (fileLines[i + k]!.trimEnd() !== searchLines[k]!.trimEnd()) {
          matches = false;
          break;
        }
      }
      if (matches) trailingMatches.push(i);
    }

    if (trailingMatches.length === 1) {
      const matchLine = trailingMatches[0]!;
      const { startOffset, length } = computeLfRangeFromLines(matchLine, matchLine + searchLines.length);
      const mapped = mapLfRangeToOriginal(originalContent, lfMap, startOffset, length);
      return {
        found: true,
        match: {
          start: mapped.start,
          end: mapped.end,
          matchedText: mapped.matchedText,
          newText: adaptLineEndings(newLF, nativeEnding),
          strategy: "trailing-whitespace",
        },
      };
    }
    if (trailingMatches.length > 1) {
      const lines = trailingMatches.map((l) => l + 1);
      return {
        found: false,
        failure: {
          success: false,
          reason: "ambiguous",
          hunkIndex,
          occurrences: trailingMatches.length,
          matchingLines: lines,
          message: `Found ${trailingMatches.length} occurrences matching with trailing whitespace tolerance at lines ${lines.join(", ")}. Provide more surrounding context to make it unique.`,
        },
      };
    }

    // 3B. Indentation tolerant matching (trim)
    const indentMatches: number[] = [];
    for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
      let matches = true;
      for (let k = 0; k < searchLines.length; k++) {
        if (fileLines[i + k]!.trim() !== searchLines[k]!.trim()) {
          matches = false;
          break;
        }
      }
      if (matches) indentMatches.push(i);
    }

    if (indentMatches.length === 1) {
      const matchLine = indentMatches[0]!;
      const { startOffset, length } = computeLfRangeFromLines(matchLine, matchLine + searchLines.length);
      const mapped = mapLfRangeToOriginal(originalContent, lfMap, startOffset, length);
      const adaptedNew = adaptIndentation(
        fileLines.slice(matchLine, matchLine + searchLines.length),
        searchLines,
        newLF,
      );

      return {
        found: true,
        match: {
          start: mapped.start,
          end: mapped.end,
          matchedText: mapped.matchedText,
          newText: adaptLineEndings(adaptedNew, nativeEnding),
          strategy: "indentation",
        },
      };
    }
    if (indentMatches.length > 1) {
      const lines = indentMatches.map((l) => l + 1);
      return {
        found: false,
        failure: {
          success: false,
          reason: "ambiguous",
          hunkIndex,
          occurrences: indentMatches.length,
          matchingLines: lines,
          message: `Found ${indentMatches.length} occurrences matching with indentation tolerance at lines ${lines.join(", ")}. Provide more surrounding context to make it unique.`,
        },
      };
    }
  }

  // 3C. Leading/Trailing Blank Line Tolerance
  let coreStart = 0;
  while (coreStart < searchLines.length && searchLines[coreStart]!.trim() === "") {
    coreStart++;
  }
  let coreEnd = searchLines.length;
  while (coreEnd > coreStart && searchLines[coreEnd - 1]!.trim() === "") {
    coreEnd--;
  }

  if (coreStart > 0 || coreEnd < searchLines.length) {
    const coreSearchLines = searchLines.slice(coreStart, coreEnd);
    if (coreSearchLines.length > 0 && coreSearchLines.length <= fileLines.length) {
      const coreMatches: number[] = [];
      for (let i = 0; i <= fileLines.length - coreSearchLines.length; i++) {
        let matches = true;
        for (let k = 0; k < coreSearchLines.length; k++) {
          if (fileLines[i + k]!.trim() !== coreSearchLines[k]!.trim()) {
            matches = false;
            break;
          }
        }
        if (matches) coreMatches.push(i);
      }

      if (coreMatches.length === 1) {
        const coreMatchLine = coreMatches[0]!;
        let actualStartLine = coreMatchLine;
        let actualEndLine = coreMatchLine + coreSearchLines.length;

        // Absorb matching leading blank lines if present in file
        for (let b = 1; b <= coreStart; b++) {
          if (actualStartLine > 0 && fileLines[actualStartLine - 1]!.trim() === "") {
            actualStartLine--;
          }
        }
        // Absorb matching trailing blank lines if present in file
        const trailingBlankCount = searchLines.length - coreEnd;
        for (let b = 1; b <= trailingBlankCount; b++) {
          if (actualEndLine < fileLines.length && fileLines[actualEndLine]!.trim() === "") {
            actualEndLine++;
          }
        }

        const { startOffset, length } = computeLfRangeFromLines(actualStartLine, actualEndLine);
        const mapped = mapLfRangeToOriginal(originalContent, lfMap, startOffset, length);
        return {
          found: true,
          match: {
            start: mapped.start,
            end: mapped.end,
            matchedText: mapped.matchedText,
            newText: adaptLineEndings(newLF, nativeEnding),
            strategy: "blank-line-tolerant",
          },
        };
      }
      if (coreMatches.length > 1) {
        const lines = coreMatches.map((l) => l + 1);
        return {
          found: false,
          failure: {
            success: false,
            reason: "ambiguous",
            hunkIndex,
            occurrences: coreMatches.length,
            matchingLines: lines,
            message: `Found ${coreMatches.length} occurrences matching trimmed block at lines ${lines.join(", ")}. Provide more surrounding context to make it unique.`,
          },
        };
      }
    }
  }

  // --------------------------------------------------------------------------
  // LAYER 4: Conservative Fuzzy Match & Unicode Normalization
  // --------------------------------------------------------------------------
  // 4A. Unicode & Punctuation Normalization
  const unicodeContent = normalizeUnicode(contentLF);
  const unicodeOld = normalizeUnicode(oldLF);
  const unicodeIndices = findExactOccurrences(unicodeContent, unicodeOld);

  if (unicodeIndices.length === 1) {
    const uStart = unicodeIndices[0]!;
    const mapped = mapLfRangeToOriginal(originalContent, lfMap, uStart, unicodeOld.length);
    return {
      found: true,
      match: {
        start: mapped.start,
        end: mapped.end,
        matchedText: mapped.matchedText,
        newText: adaptLineEndings(newLF, nativeEnding),
        strategy: "unicode-normalized",
      },
    };
  }
  if (unicodeIndices.length > 1) {
    const lines = unicodeIndices.map((idx) => getLineNumber(contentLF, idx));
    return {
      found: false,
      failure: {
        success: false,
        reason: "ambiguous",
        hunkIndex,
        occurrences: unicodeIndices.length,
        matchingLines: lines,
        message: `Found ${unicodeIndices.length} occurrences matching with Unicode normalization at lines ${lines.join(", ")}. Provide more surrounding context to make it unique.`,
      },
    };
  }

  // 4B. Windowed Levenshtein Scanning for Minor Character Variations
  // Strict confidence threshold: >= 0.92 similarity, with uniqueness requirement
  const targetLinesCount = Math.max(1, searchLines.length);
  interface CandidateWindow {
    lineIndex: number;
    text: string;
    similarity: number;
  }

  const candidates: CandidateWindow[] = [];
  const minLines = Math.max(1, targetLinesCount - 1);
  const maxLines = targetLinesCount + 1;

  for (let span = minLines; span <= maxLines; span++) {
    if (span > fileLines.length) continue;
    for (let i = 0; i <= fileLines.length - span; i++) {
      const windowLines = fileLines.slice(i, i + span);
      const windowText = windowLines.join("\n");
      const sim = calculateSimilarity(oldLF, windowText);
      if (sim >= 0.50) {
        candidates.push({ lineIndex: i, text: windowText, similarity: sim });
      }
    }
  }

  candidates.sort((a, b) => b.similarity - a.similarity);

  const bestCandidate = candidates[0];

  // If best candidate meets strict threshold (>= 0.92)
  if (bestCandidate && bestCandidate.similarity >= 0.92) {
    // Check ambiguity: is there a second candidate close to the best?
    const secondCandidate = candidates.find(
      (c) => Math.abs(c.lineIndex - bestCandidate.lineIndex) >= targetLinesCount,
    );
    if (secondCandidate && secondCandidate.similarity >= 0.85) {
      const l1 = bestCandidate.lineIndex + 1;
      const l2 = secondCandidate.lineIndex + 1;
      return {
        found: false,
        failure: {
          success: false,
          reason: "ambiguous",
          hunkIndex,
          occurrences: 2,
          matchingLines: [l1, l2],
          message: `Ambiguous fuzzy match: multiple candidate locations found around lines ${l1} (${Math.round(bestCandidate.similarity * 100)}%) and ${l2} (${Math.round(secondCandidate.similarity * 100)}%). Provide more context to make it unique.`,
        },
      };
    }

    // Unique high-confidence match!
    const windowLineCount = bestCandidate.text.split("\n").length;
    const { startOffset, length } = computeLfRangeFromLines(
      bestCandidate.lineIndex,
      bestCandidate.lineIndex + windowLineCount,
    );
    const mapped = mapLfRangeToOriginal(originalContent, lfMap, startOffset, length);

    return {
      found: true,
      match: {
        start: mapped.start,
        end: mapped.end,
        matchedText: mapped.matchedText,
        newText: adaptLineEndings(newLF, nativeEnding),
        strategy: "fuzzy",
      },
    };
  }

  // --------------------------------------------------------------------------
  // DIAGNOSTICS: Near-Miss Reporting when Match Fails
  // --------------------------------------------------------------------------
  let nearMiss: NearMissDiagnostic | undefined;
  if (bestCandidate && bestCandidate.similarity >= 0.50) {
    nearMiss = {
      line: bestCandidate.lineIndex + 1,
      similarity: Math.round(bestCandidate.similarity * 100),
      expectedSnippet: truncateString(oldString, 100),
      foundSnippet: truncateString(bestCandidate.text, 100),
      differences: describeDifferences(oldString, bestCandidate.text),
    };
  }

  let diagMsg = `String "${truncateString(oldString, 60)}" not found in file.`;
  if (nearMiss) {
    diagMsg += `\nNear-miss found around line ${nearMiss.line} (${nearMiss.similarity}% match):`;
    diagMsg += `\n  Expected: "${nearMiss.expectedSnippet}"`;
    diagMsg += `\n  Found:    "${nearMiss.foundSnippet}"`;
    diagMsg += `\n  Difference: ${nearMiss.differences}`;
  } else {
    diagMsg += ` Make sure old_string matches the file content, or use read_file to inspect the current file content.`;
  }

  return {
    found: false,
    failure: {
      success: false,
      reason: "not_found",
      hunkIndex,
      nearMiss,
      message: diagMsg,
    },
  };
}

// ==========================================
// 5. Multi-Hunk Orchestration & Overlap Check
// ==========================================

export function planAndValidateEdits(
  originalContent: string,
  hunks: EditHunk[],
  filePath = "file",
): EditResult {
  if (hunks.length === 0) {
    return {
      success: false,
      reason: "empty_old_string",
      message: "No edit hunks provided",
    };
  }

  const matches: MatchedHunk[] = [];

  // Match all hunks against original content
  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i]!;
    const result = matchSingleHunk(originalContent, hunk, i);

    if (!result.found) {
      const hunkPrefix = hunks.length > 1 ? `edits[${i}]: ` : "";
      return {
        ...result.failure,
        message: `${hunkPrefix}${result.failure.message}`,
      };
    }

    const { match } = result;
    const startLine = getLineNumber(originalContent, match.start);
    const endLine = getLineNumber(originalContent, match.end);

    matches.push({
      originalIndex: i,
      start: match.start,
      end: match.end,
      startLine,
      endLine,
      matchedText: match.matchedText,
      newText: match.newText,
      strategy: match.strategy,
    });
  }

  // Detect overlapping ranges among matched blocks
  const sorted = [...matches].sort((a, b) => a.start - b.start);
  for (let j = 1; j < sorted.length; j++) {
    const prev = sorted[j - 1]!;
    const curr = sorted[j]!;
    if (prev.end > curr.start) {
      return {
        success: false,
        reason: "overlapping",
        message: `Overlapping edit ranges detected: edits[${prev.originalIndex}] (lines ${prev.startLine}-${prev.endLine}) and edits[${curr.originalIndex}] (lines ${curr.startLine}-${curr.endLine}) overlap in ${filePath}. Merge them into a single edit or target disjoint regions.`,
      };
    }
  }

  // Apply edits from bottom to top (highest start to lowest start) to preserve byte offsets
  let updatedContent = originalContent;
  const sortedDesc = [...matches].sort((a, b) => b.start - a.start);
  for (const m of sortedDesc) {
    updatedContent = updatedContent.slice(0, m.start) + m.newText + updatedContent.slice(m.end);
  }

  if (updatedContent === originalContent) {
    return {
      success: false,
      reason: "no_change",
      message: `No changes made to ${filePath}: replacements produced identical content.`,
    };
  }

  const diffLines = computeDiff(originalContent, updatedContent);

  return {
    success: true,
    matches: sorted,
    updatedContent,
    diffLines,
  };
}

// ==========================================
// 6. Atomic File Update Helper
// ==========================================

export async function writeAtomicFile(
  filePath: string,
  content: string,
): Promise<void> {
  const dir = dirname(filePath);
  const base = basename(filePath);
  const tempPath = join(
    dir,
    `.${base}.agav-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );

  let fileMode: number | undefined;
  try {
    const stats = await stat(filePath);
    fileMode = stats.mode;
  } catch {
    // File may not exist yet or mode unavailable
  }

  try {
    await writeFile(tempPath, content, {
      encoding: "utf-8",
      mode: fileMode,
    });

    try {
      await rename(tempPath, filePath);
    } catch {
      // Fallback for Windows file locks or cross-device link issues
      await writeFile(filePath, content, "utf-8");
      try {
        await unlink(tempPath);
      } catch {}
    }
  } catch (err) {
    try {
      await unlink(tempPath);
    } catch {}
    throw err;
  }
}
