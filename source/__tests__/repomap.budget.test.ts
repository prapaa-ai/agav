import { describe, expect, it } from 'vitest';
import {
  BinarySearchBudgetOptimizer,
  fitToBudget,
  formatFileSkeleton,
  formatSymbolSignature,
} from '../repomap/budget/binary-search-fit.js';
import type { FileNode, SymbolNode } from '../repomap/graph/symbol-graph.js';
import { estimateTokens } from '../utils/tokens.js';

describe('BinarySearchBudgetOptimizer', () => {
  const sampleFile: FileNode = {
    id: 'file:path/to/file.ts',
    path: 'path/to/file.ts',
  };

  const sampleSymbols: SymbolNode[] = [
    {
      id: 'file:path/to/file.ts:10:walkDir',
      filePath: 'path/to/file.ts',
      name: 'walkDir',
      line: 10,
      kind: 'function',
      exported: true,
    },
    {
      id: 'file:path/to/file.ts:25:GraphEngine',
      filePath: 'path/to/file.ts',
      name: 'GraphEngine',
      line: 25,
      kind: 'class',
      exported: true,
    },
    {
      id: 'file:path/to/file.ts:50:internalHelper',
      filePath: 'path/to/file.ts',
      name: 'internalHelper',
      line: 50,
      kind: 'function',
      exported: false,
    },
  ];

  it('formats clean code skeleton matching prompt example', () => {
    const selectedIds = new Set([
      'file:path/to/file.ts:10:walkDir',
      'file:path/to/file.ts:25:GraphEngine',
    ]);

    const formatted = formatFileSkeleton(sampleFile, sampleSymbols, selectedIds);
    expect(formatted).toBe(
      'path/to/file.ts:\n  export function walkDir(...)\n  export class GraphEngine { ... }'
    );
  });

  it('uses custom signature when provided', () => {
    const customSym: SymbolNode = {
      id: 'file:test.ts:1:custom',
      filePath: 'test.ts',
      name: 'custom',
      line: 1,
      signature: 'export async function custom<T>(arg: T): Promise<T>',
    };
    const file: FileNode = { id: 'file:test.ts', path: 'test.ts' };
    const formatted = formatFileSkeleton(file, [customSym], new Set([customSym.id]));
    expect(formatted).toBe('test.ts:\n  export async function custom<T>(arg: T): Promise<T>');
  });

  it('formats various symbol kinds accurately', () => {
    expect(
      formatSymbolSignature({
        id: '1',
        filePath: 'a.ts',
        name: 'User',
        line: 1,
        kind: 'interface',
        exported: true,
      })
    ).toBe('export interface User { ... }');

    expect(
      formatSymbolSignature({
        id: '2',
        filePath: 'a.ts',
        name: 'Config',
        line: 2,
        kind: 'type',
        exported: false,
      })
    ).toBe('type Config');

    expect(
      formatSymbolSignature({
        id: '3',
        filePath: 'a.ts',
        name: 'MAX_LIMIT',
        line: 3,
        kind: 'const',
        exported: true,
      })
    ).toBe('export const MAX_LIMIT');

    expect(
      formatSymbolSignature({
        id: '4',
        filePath: 'a.ts',
        name: 'render',
        line: 4,
        kind: 'method',
      })
    ).toBe('render(...)');
  });

  it('strictly adheres to token budget across varying limits', () => {
    const files: FileNode[] = [];
    const symbols: SymbolNode[] = [];
    const scores = new Map<string, number>();

    // Create 10 files, each with 5 symbols of decreasing scores
    for (let fIdx = 0; fIdx < 10; fIdx++) {
      const fPath = `src/module_${fIdx}.ts`;
      const fId = `file:${fPath}`;
      files.push({ id: fId, path: fPath });
      scores.set(fId, 1.0 - fIdx * 0.08);

      for (let sIdx = 0; sIdx < 5; sIdx++) {
        const sName = `func_${fIdx}_${sIdx}`;
        const sId = `${fId}:${10 * (sIdx + 1)}:${sName}`;
        symbols.push({
          id: sId,
          filePath: fPath,
          name: sName,
          line: 10 * (sIdx + 1),
          kind: 'function',
          exported: true,
        });
        // Highest ranked symbols get scores up to 1.0
        scores.set(sId, (10 - fIdx) * 0.1 * (5 - sIdx) * 0.2);
      }
    }

    // Full rendering token count
    const fullResult = fitToBudget(files, symbols, scores, 10000);
    const fullTokens = fullResult.tokenCount;
    expect(fullResult.selectedFiles.length).toBe(10);
    expect(fullResult.selectedSymbols.length).toBe(50);

    // Test a suite of tight budget limits
    const budgetTargets = [20, 50, 100, 200, 350, 500, fullTokens];

    for (const budget of budgetTargets) {
      const result = fitToBudget(files, symbols, scores, budget);
      expect(result.tokenCount).toBeLessThanOrEqual(budget);
      expect(estimateTokens(result.text)).toBe(result.tokenCount);
    }
  });

  it('prioritizes high-PageRank symbols when budget is limited', () => {
    const file: FileNode = { id: 'file:src/core.ts', path: 'src/core.ts' };
    const symTop: SymbolNode = {
      id: 'file:src/core.ts:10:topImportant',
      filePath: 'src/core.ts',
      name: 'topImportant',
      line: 10,
      kind: 'function',
      exported: true,
    };
    const symMed: SymbolNode = {
      id: 'file:src/core.ts:20:mediumImportant',
      filePath: 'src/core.ts',
      name: 'mediumImportant',
      line: 20,
      kind: 'function',
      exported: true,
    };
    const symLow: SymbolNode = {
      id: 'file:src/core.ts:30:lowImportant',
      filePath: 'src/core.ts',
      name: 'lowImportant',
      line: 30,
      kind: 'function',
      exported: true,
    };

    const scores = new Map<string, number>();
    scores.set(file.id, 1.0);
    scores.set(symTop.id, 1.0);
    scores.set(symMed.id, 0.5);
    scores.set(symLow.id, 0.1);

    // Fit to a budget that only accommodates ~1 symbol
    const oneSymbolText = formatFileSkeleton(file, [symTop], new Set([symTop.id]));
    const oneSymbolBudget = estimateTokens(oneSymbolText);

    const tightResult = fitToBudget(
      [file],
      [symTop, symMed, symLow],
      scores,
      oneSymbolBudget + 1
    );

    expect(tightResult.tokenCount).toBeLessThanOrEqual(oneSymbolBudget + 1);
    expect(tightResult.selectedSymbols).toContain(symTop.id);
    expect(tightResult.selectedSymbols).not.toContain(symLow.id);
  });

  it('handles edge cases: budget 0, negative budget, and empty inputs', () => {
    const zeroBudget = fitToBudget([sampleFile], sampleSymbols, new Map(), 0);
    expect(zeroBudget.tokenCount).toBe(0);
    expect(zeroBudget.text).toBe('');
    expect(zeroBudget.selectedFiles).toHaveLength(0);

    const negativeBudget = fitToBudget([sampleFile], sampleSymbols, new Map(), -10);
    expect(negativeBudget.tokenCount).toBe(0);
    expect(negativeBudget.text).toBe('');

    const emptyInput = fitToBudget([], [], new Map(), 500);
    expect(emptyInput.tokenCount).toBe(0);
    expect(emptyInput.text).toBe('');
  });

  it('works identically via BinarySearchBudgetOptimizer class instance and static methods', () => {
    const optimizer = new BinarySearchBudgetOptimizer();
    const scores = new Map<string, number>([
      [sampleFile.id, 1.0],
      [sampleSymbols[0]!.id, 1.0],
    ]);

    const resultInstance = optimizer.fitToBudget([sampleFile], sampleSymbols, scores, 200);
    const resultStatic = BinarySearchBudgetOptimizer.fitToBudget(
      [sampleFile],
      sampleSymbols,
      scores,
      200
    );

    expect(resultInstance.text).toBe(resultStatic.text);
    expect(resultInstance.tokenCount).toBe(resultStatic.tokenCount);
    expect(resultInstance.selectedFiles).toEqual(resultStatic.selectedFiles);
    expect(resultInstance.selectedSymbols).toEqual(resultStatic.selectedSymbols);
  });
});
