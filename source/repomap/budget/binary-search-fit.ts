import { estimateTokens } from '../../utils/tokens.js';
import type { FileNode, SymbolNode } from '../graph/symbol-graph.js';
import { toFileNodeId } from '../graph/symbol-graph.js';

export interface BudgetFitResult {
  text: string;
  tokenCount: number;
  selectedFiles: string[];
  selectedSymbols: string[];
}

/**
 * Format a symbol definition into a concise skeleton signature line.
 */
export function formatSymbolSignature(symbol: SymbolNode): string {
  if (symbol.signature) {
    return symbol.signature;
  }

  const exp = symbol.exported ? 'export ' : '';
  const kind = (symbol.kind ?? '').toLowerCase();

  switch (kind) {
    case 'function':
      return `${exp}function ${symbol.name}(...)`;
    case 'class':
      return `${exp}class ${symbol.name} { ... }`;
    case 'interface':
      return `${exp}interface ${symbol.name} { ... }`;
    case 'type':
      return `${exp}type ${symbol.name}`;
    case 'const':
    case 'variable':
      return `${exp}const ${symbol.name}`;
    case 'method':
      return `${symbol.name}(...)`;
    default:
      if (symbol.kind) {
        return `${exp}${symbol.kind} ${symbol.name}`;
      }
      return `${exp}${symbol.name}`;
  }
}

/**
 * Renders a clean indentation-structured code skeleton for a file and its selected symbols.
 * Example:
 * path/to/file.ts:
 *   export function walkDir(...)
 *   export class GraphEngine { ... }
 */
export function formatFileSkeleton(
  file: FileNode,
  symbols: SymbolNode[],
  selectedSymbolIds: Set<string>
): string {
  const selectedSymbols = symbols
    .filter(s => selectedSymbolIds.has(s.id))
    .sort((a, b) => a.line - b.line);

  const displayPath = file.path ?? file.file ?? (file.id ? file.id.replace(/^file:/, '') : '');
  const lines: string[] = [`${displayPath}:`];
  for (const sym of selectedSymbols) {
    lines.push(`  ${formatSymbolSignature(sym)}`);
  }

  return lines.join('\n');
}

/**
 * Binary search budget optimizer:
 * - Cost(theta) is the token count of rendering files and symbols with score >= theta.
 * - Performs binary search over score threshold theta in [0, maxScore] to find theta*
 *   such that Cost(theta*) <= budgetTokens.
 * - Strictly respects budgetTokens and prioritizes high-PageRank symbols.
 */
export function fitToBudget(
  files: FileNode[],
  symbols: SymbolNode[],
  scores: Map<string, number>,
  budgetTokens: number
): BudgetFitResult {
  if (budgetTokens <= 0 || (files.length === 0 && symbols.length === 0)) {
    return {
      text: '',
      tokenCount: 0,
      selectedFiles: [],
      selectedSymbols: [],
    };
  }

  // Build lookup index: fileId -> FileNode
  const fileById = new Map<string, FileNode>();
  for (const file of files) {
    const rawPath = file.path ?? file.file ?? '';
    const canonicalId = file.id ?? toFileNodeId(rawPath);
    fileById.set(canonicalId, file);
    if (rawPath) fileById.set(rawPath, file);
  }

  // Associate symbols with their parent files
  const symbolsByFileId = new Map<string, SymbolNode[]>();
  for (const file of files) {
    const rawPath = file.path ?? file.file ?? '';
    const canonicalId = file.id ?? toFileNodeId(rawPath);
    symbolsByFileId.set(canonicalId, []);
  }

  for (const sym of symbols) {
    const rawPath = sym.filePath ?? sym.file ?? '';
    const fId = sym.fileId ?? (rawPath ? toFileNodeId(rawPath) : '');
    let list = symbolsByFileId.get(fId);
    if (!list) {
      list = [];
      symbolsByFileId.set(fId, list);
    }
    list.push(sym);
  }

  // Determine max score
  let maxScore = 0;
  for (const f of files) {
    const rawPath = f.path ?? f.file ?? '';
    const fid = f.id ?? toFileNodeId(rawPath);
    const s = scores.get(fid) ?? (rawPath ? scores.get(rawPath) : undefined) ?? 0;
    if (s > maxScore) maxScore = s;
  }
  for (const sym of symbols) {
    const s = scores.get(sym.id) ?? 0;
    if (s > maxScore) maxScore = s;
  }

  // Evaluates the skeleton candidate for a given threshold theta
  function renderCandidate(theta: number): BudgetFitResult {
    const selectedSyms = symbols.filter(s => (scores.get(s.id) ?? 0) >= theta);
    const selectedSymIds = new Set(selectedSyms.map(s => s.id));

    // File is included if its own score >= theta OR any of its symbols is selected
    const selectedF = files.filter(f => {
      const rawPath = f.path ?? f.file ?? '';
      const fid = f.id ?? toFileNodeId(rawPath);
      const fScore = scores.get(fid) ?? (rawPath ? scores.get(rawPath) : undefined) ?? 0;
      if (fScore >= theta) return true;
      const fSymbols = symbolsByFileId.get(fid) ?? [];
      return fSymbols.some(s => selectedSymIds.has(s.id));
    });

    // Sort files by file score descending, then by path
    selectedF.sort((a, b) => {
      const rawPathA = a.path ?? a.file ?? '';
      const rawPathB = b.path ?? b.file ?? '';
      const aid = a.id ?? toFileNodeId(rawPathA);
      const bid = b.id ?? toFileNodeId(rawPathB);
      const sa = scores.get(aid) ?? (rawPathA ? scores.get(rawPathA) : undefined) ?? 0;
      const sb = scores.get(bid) ?? (rawPathB ? scores.get(rawPathB) : undefined) ?? 0;
      if (sb !== sa) return sb - sa;
      return rawPathA.localeCompare(rawPathB);
    });

    const fileTexts: string[] = [];
    for (const f of selectedF) {
      const rawPath = f.path ?? f.file ?? '';
      const fid = f.id ?? toFileNodeId(rawPath);
      const fSymbols = symbolsByFileId.get(fid) ?? [];
      fileTexts.push(formatFileSkeleton(f, fSymbols, selectedSymIds));
    }

    const text = fileTexts.join('\n');
    const tokenCount = estimateTokens(text);

    return {
      text,
      tokenCount,
      selectedFiles: selectedF.map(f => f.id ?? toFileNodeId(f.path ?? f.file ?? '')),
      selectedSymbols: selectedSyms.map(s => s.id),
    };
  }

  // If everything fits at theta = 0, return complete map
  const fullCandidate = renderCandidate(0);
  if (fullCandidate.tokenCount <= budgetTokens) {
    return fullCandidate;
  }

  // Binary search over [0, maxScore + 1e-4]
  let low = 0;
  let high = maxScore + 1e-4;
  let bestCandidate: BudgetFitResult = {
    text: '',
    tokenCount: 0,
    selectedFiles: [],
    selectedSymbols: [],
  };

  for (let iter = 0; iter < 60; iter++) {
    const mid = (low + high) / 2;
    const candidate = renderCandidate(mid);

    if (candidate.tokenCount <= budgetTokens) {
      bestCandidate = candidate;
      // Fits in budget! Try lowering theta to include more symbols
      high = mid;
    } else {
      // Exceeds budget, must raise threshold theta
      low = mid;
    }

    if (high - low < 1e-7) {
      break;
    }
  }

  // Safety verification: ensure result strictly adheres to budgetTokens
  if (bestCandidate.tokenCount > budgetTokens) {
    bestCandidate = renderCandidate(high);
    if (bestCandidate.tokenCount > budgetTokens) {
      return {
        text: '',
        tokenCount: 0,
        selectedFiles: [],
        selectedSymbols: [],
      };
    }
  }

  return bestCandidate;
}

export class BinarySearchBudgetOptimizer {
  public static formatFileSkeleton = formatFileSkeleton;
  public static fitToBudget = fitToBudget;

  public formatFileSkeleton(
    file: FileNode,
    symbols: SymbolNode[],
    selectedSymbolIds: Set<string>
  ): string {
    return formatFileSkeleton(file, symbols, selectedSymbolIds);
  }

  public fitToBudget(
    files: FileNode[],
    symbols: SymbolNode[],
    scores: Map<string, number>,
    budgetTokens: number
  ): BudgetFitResult {
    return fitToBudget(files, symbols, scores, budgetTokens);
  }
}
