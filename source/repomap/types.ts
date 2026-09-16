/**
 * Core type definitions for Agav repository mapping, AST symbol extraction,
 * and graph-based ranking.
 */

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'struct'
  | 'trait'
  | 'variable';

export type EdgeKind =
  | 'containment'
  | 'import'
  | 'call'
  | 'inheritance'
  | 'type_ref';

export interface SymbolNode {
  id: string;
  name: string;
  kind: SymbolKind;
  file: string;
  filePath?: string;
  fileId?: string;
  line: number;
  endLine?: number;
  signature: string;
  exported: boolean;
  parentId?: string;
  type?: 'symbol';
  [key: string]: unknown;
}

export interface FileNode {
  id?: string;
  path?: string;
  file: string;
  language: string;
  size: number;
  mtime: number;
  symbols: string[];
  type?: 'file';
  [key: string]: unknown;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  weight: number;
}

export interface PageRankOptions {
  alpha?: number;
  epsilon?: number;
  maxIterations?: number;
  seedFiles?: string[];
}

export interface RepoMapOptions {
  budget?: number;
  focusFiles?: string[];
  maxFiles?: number;
  depth?: number;
  verbose?: boolean;
}

export interface RepoMapResult {
  text: string;
  tokenCount: number;
  fileCount: number;
  symbolCount: number;
  topFiles: { file: string; score: number }[];
}

export interface Reference {
  name: string;
  kind: EdgeKind;
  line: number;
  sourceSymbolId?: string;
}

export interface ParseResult {
  symbols: SymbolNode[];
  references: Reference[];
}

export interface LanguageExtractor {
  extract(content: string, file: string, tree?: unknown, cursor?: unknown): ParseResult;
}
