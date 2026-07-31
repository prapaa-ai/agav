export interface DiffLine {
  type: "add" | "remove" | "context" | "separator";
  lineNo?: number;
  text: string;
}

export function computeDiff(
  oldStr: string,
  newStr: string,
  contextLines = 3,
): DiffLine[] {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  const lcs = buildLCS(oldLines, newLines);
  const rawOps = buildOps(oldLines, newLines, lcs);

  return buildHunks(rawOps, contextLines);
}

export function computeEditDiff(
  fileContent: string,
  oldString: string,
  newString: string,
  contextLines = 3,
): DiffLine[] {
  const allLines = fileContent.split("\n");
  const pos = fileContent.indexOf(oldString);
  if (pos === -1) return [];

  const beforeChange = fileContent.slice(0, pos);
  const startLine = beforeChange.split("\n").length - 1;

  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");
  const endLine = startLine + oldLines.length;

  const result: DiffLine[] = [];

  const ctxStart = Math.max(0, startLine - contextLines);
  if (ctxStart > 0) {
    result.push({ type: "separator", text: "..." });
  }

  // Context before — use old line numbers
  for (let i = ctxStart; i < startLine; i++) {
    result.push({ type: "context", lineNo: i + 1, text: allLines[i]! });
  }

  // Removed lines — old line numbers
  for (let i = 0; i < oldLines.length; i++) {
    result.push({ type: "remove", lineNo: startLine + i + 1, text: oldLines[i]! });
  }

  // Added lines — new line numbers (adjusted for the size change)
  for (let i = 0; i < newLines.length; i++) {
    result.push({ type: "add", lineNo: startLine + i + 1, text: newLines[i]! });
  }

  // Context after — use new line numbers (shifted by size delta)
  const delta = newLines.length - oldLines.length;
  const ctxEnd = Math.min(allLines.length, endLine + contextLines);
  for (let i = endLine; i < ctxEnd; i++) {
    result.push({ type: "context", lineNo: i + 1 + delta, text: allLines[i]! });
  }

  if (ctxEnd < allLines.length) {
    result.push({ type: "separator", text: "..." });
  }

  return result;
}

type Op = {
  type: "equal" | "insert" | "delete";
  oldLineNo: number;
  newLineNo: number;
  text: string;
};

function buildLCS(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0) as number[],
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }
  return dp;
}

function buildOps(a: string[], b: string[], dp: number[][]): Op[] {
  const ops: Op[] = [];
  let i = a.length;
  let j = b.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.unshift({ type: "equal", oldLineNo: i, newLineNo: j, text: a[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      ops.unshift({ type: "insert", oldLineNo: 0, newLineNo: j, text: b[j - 1]! });
      j--;
    } else {
      ops.unshift({ type: "delete", oldLineNo: i, newLineNo: 0, text: a[i - 1]! });
      i--;
    }
  }
  return ops;
}

function buildHunks(ops: Op[], contextLines: number): DiffLine[] {
  const changes: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.type !== "equal") changes.push(i);
  }

  if (changes.length === 0) return [];

  const visible = new Set<number>();
  for (const idx of changes) {
    for (
      let j = Math.max(0, idx - contextLines);
      j <= Math.min(ops.length - 1, idx + contextLines);
      j++
    ) {
      visible.add(j);
    }
  }

  const result: DiffLine[] = [];
  let lastShown = -1;

  for (let i = 0; i < ops.length; i++) {
    if (!visible.has(i)) continue;

    if (lastShown !== -1 && i - lastShown > 1) {
      result.push({ type: "separator", text: "..." });
    }

    const op = ops[i]!;
    if (op.type === "equal") {
      result.push({ type: "context", lineNo: op.newLineNo, text: op.text });
    } else if (op.type === "delete") {
      result.push({ type: "remove", lineNo: op.oldLineNo, text: op.text });
    } else {
      result.push({ type: "add", lineNo: op.newLineNo, text: op.text });
    }

    lastShown = i;
  }

  return result;
}
