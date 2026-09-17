import { readFile } from 'node:fs/promises';
import type { ParseResult } from '../types.js';
import { detectLanguage, getExtractor } from './extractors/index.js';

export interface SyntaxNode {
  type: string;
  text: string;
  line: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
  children: SyntaxNode[];
  parent?: SyntaxNode;
}

export class SafeSyntaxCursor {
  private current: SyntaxNode;
  private isDeleted = false;

  constructor(root: SyntaxNode) {
    this.current = root;
  }

  currentNode(): SyntaxNode {
    if (this.isDeleted) {
      throw new Error('Attempted to use disposed SyntaxCursor');
    }
    return this.current;
  }

  gotoFirstChild(): boolean {
    if (this.isDeleted || !this.current.children || this.current.children.length === 0) {
      return false;
    }
    this.current = this.current.children[0]!;
    return true;
  }

  gotoNextSibling(): boolean {
    if (this.isDeleted || !this.current.parent) {
      return false;
    }
    const siblings = this.current.parent.children;
    const index = siblings.indexOf(this.current);
    if (index >= 0 && index + 1 < siblings.length) {
      this.current = siblings[index + 1]!;
      return true;
    }
    return false;
  }

  gotoParent(): boolean {
    if (this.isDeleted || !this.current.parent) {
      return false;
    }
    this.current = this.current.parent;
    return true;
  }

  delete(): void {
    this.isDeleted = true;
    // Clear reference to avoid memory leaks
    this.current = null as unknown as SyntaxNode;
  }

  get isDisposed(): boolean {
    return this.isDeleted;
  }
}

export class SafeSyntaxTree {
  public rootNode: SyntaxNode;
  public language: string;
  public filePath: string;
  private isDeleted = false;

  constructor(language: string, filePath: string, rootNode: SyntaxNode) {
    this.language = language;
    this.filePath = filePath;
    this.rootNode = rootNode;
  }

  walk(): SafeSyntaxCursor {
    if (this.isDeleted) {
      throw new Error('Attempted to walk disposed SyntaxTree');
    }
    return new SafeSyntaxCursor(this.rootNode);
  }

  delete(): void {
    this.isDeleted = true;
    // Sever references across the tree nodes to allow GC cleanup
    const clearNode = (node: SyntaxNode) => {
      for (const child of node.children) {
        clearNode(child);
      }
      node.children = [];
      node.parent = undefined;
    };
    if (this.rootNode) {
      clearNode(this.rootNode);
      this.rootNode = null as unknown as SyntaxNode;
    }
  }

  get isDisposed(): boolean {
    return this.isDeleted;
  }
}

export interface SafeParserOptions {
  recycleThreshold?: number;
}

/**
 * SafeTreeSitterParser manages tree and cursor lifecycles, guarantees resource disposal,
 * automatically recycles internal parser state after processing 250 files to prevent leaks,
 * and maintains an error boundary to prevent parsing failures from crashing the host process.
 */
export class SafeTreeSitterParser {
  public static readonly DEFAULT_RECYCLE_THRESHOLD = 250;

  private parseCount = 0;
  private recycleCount = 0;
  private disposedTreeCount = 0;
  private disposedCursorCount = 0;
  private readonly recycleThreshold: number;
  private parserCache: Map<string, unknown> = new Map();

  constructor(options?: SafeParserOptions) {
    this.recycleThreshold = options?.recycleThreshold ?? SafeTreeSitterParser.DEFAULT_RECYCLE_THRESHOLD;
  }

  /**
   * Parse a file's content and extract symbols and references.
   * Ensures tree/cursor disposal and catches all parsing exceptions.
   */
  public parse(filePath: string, content: string): ParseResult {
    let tree: SafeSyntaxTree | null = null;
    let cursor: SafeSyntaxCursor | null = null;

    try {
      const language = detectLanguage(filePath);
      tree = this.createTree(language, content, filePath);

      try {
        cursor = tree.walk();
        const extractor = getExtractor(language);
        return extractor.extract(content, filePath, tree, cursor);
      } finally {
        if (cursor) {
          cursor.delete();
          this.disposedCursorCount++;
        }
      }
    } catch {
      // Graceful error boundary: return empty/partial result without crashing the process
      return { symbols: [], references: [] };
    } finally {
      if (tree) {
        tree.delete();
        this.disposedTreeCount++;
      }
      this.parseCount++;
      if (this.parseCount >= this.recycleThreshold) {
        this.recycle();
      }
    }
  }

  /**
   * Read and parse a file from disk.
   */
  public async parseFile(filePath: string, content?: string): Promise<ParseResult> {
    try {
      const fileContent = content !== undefined ? content : await readFile(filePath, 'utf-8');
      return this.parse(filePath, fileContent);
    } catch {
      return { symbols: [], references: [] };
    }
  }

  /**
   * Recycles the internal parser state, clearing caches and resetting the parse counter.
   */
  public recycle(): void {
    this.parserCache.clear();
    this.parseCount = 0;
    this.recycleCount++;
  }

  /**
   * Complete reset of parse and recycle counters.
   */
  public reset(): void {
    this.recycle();
    this.recycleCount = 0;
    this.disposedTreeCount = 0;
    this.disposedCursorCount = 0;
  }

  public getParseCount(): number {
    return this.parseCount;
  }

  public getRecycleCount(): number {
    return this.recycleCount;
  }

  public getRecycleThreshold(): number {
    return this.recycleThreshold;
  }

  public getDisposedTreeCount(): number {
    return this.disposedTreeCount;
  }

  public getDisposedCursorCount(): number {
    return this.disposedCursorCount;
  }

  /**
   * Build a lightweight CST syntax tree for the given content.
   */
  private createTree(language: string, content: string, filePath: string): SafeSyntaxTree {
    const lines = content.split(/\r?\n/);
    const rootNode: SyntaxNode = {
      type: 'program',
      text: content.slice(0, 100),
      line: 1,
      endLine: lines.length,
      children: [],
    };

    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i]!;
      const lineNode: SyntaxNode = {
        type: 'line',
        text: lineText,
        line: i + 1,
        endLine: i + 1,
        children: [],
        parent: rootNode,
      };
      rootNode.children.push(lineNode);
    }

    return new SafeSyntaxTree(language, filePath, rootNode);
  }
}

export const safeParser = new SafeTreeSitterParser();
