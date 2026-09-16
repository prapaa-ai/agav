export type EdgeKind =
  | 'containment'
  | 'import'
  | 'call'
  | 'inheritance'
  | 'type_ref';

export const DEFAULT_EDGE_WEIGHTS: Record<EdgeKind, number> = {
  containment: 1.0,
  import: 0.8,
  call: 0.5,
  inheritance: 0.7,
  type_ref: 0.4,
};

export interface FileNode {
  id: string;
  path: string;
  file?: string;
  type?: 'file';
  language?: string;
  size?: number;
  [key: string]: unknown;
}

export interface SymbolNode {
  id: string;
  name: string;
  line: number;
  filePath: string;
  file?: string;
  kind?: string;
  exported?: boolean;
  signature?: string;
  type?: 'symbol';
  fileId?: string;
  [key: string]: unknown;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  weight: number;
}

export function toFileNodeId(path: string): string {
  if (path.startsWith('file:')) {
    return path;
  }
  return `file:${path}`;
}

export function toSymbolNodeId(filePath: string, line: number, name: string): string {
  const cleanPath = filePath.startsWith('file:') ? filePath.slice(5) : filePath;
  return `file:${cleanPath}:${line}:${name}`;
}

/**
 * Directed multigraph representing source files and code symbols,
 * tracking relationships such as containment, imports, calls, inheritance, and type references.
 */
export class DirectedSymbolGraph {
  public nodes: Map<string, SymbolNode | FileNode> = new Map();
  public outEdges: Map<string, GraphEdge[]> = new Map();
  public inEdges: Map<string, GraphEdge[]> = new Map();

  /**
   * Add a generic node (FileNode or SymbolNode) to the graph.
   */
  public addNode(node: SymbolNode | FileNode): void {
    this.nodes.set(node.id, node);
  }

  /**
   * Helper to register a file node.
   */
  public addFileNode(file: { path?: string; file?: string; id?: string; [key: string]: unknown }): FileNode {
    const rawPath = file.path ?? file.file ?? '';
    const id = file.id ?? toFileNodeId(rawPath);
    const node: FileNode = {
      type: 'file',
      ...file,
      id,
      path: rawPath,
      file: file.file ?? rawPath,
    };
    this.nodes.set(id, node);
    return node;
  }

  /**
   * Helper to register a symbol node.
   */
  public addSymbolNode(symbol: {
    filePath?: string;
    file?: string;
    name: string;
    line: number;
    id?: string;
    kind?: string;
    exported?: boolean;
    signature?: string;
    [key: string]: unknown;
  }): SymbolNode {
    const rawPath = symbol.filePath ?? symbol.file ?? '';
    const id = symbol.id ?? toSymbolNodeId(rawPath, symbol.line, symbol.name);
    const fileId = toFileNodeId(rawPath);
    const node: SymbolNode = {
      type: 'symbol',
      ...symbol,
      id,
      fileId,
      filePath: rawPath,
      file: symbol.file ?? rawPath,
      name: symbol.name,
      line: symbol.line,
    };
    this.nodes.set(id, node);
    return node;
  }

  public hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  public getNode(id: string): SymbolNode | FileNode | undefined {
    return this.nodes.get(id);
  }

  public getFiles(): FileNode[] {
    const files: FileNode[] = [];
    for (const node of this.nodes.values()) {
      if (this.isFileNode(node)) {
        files.push(node);
      }
    }
    return files;
  }

  public getSymbols(): SymbolNode[] {
    const symbols: SymbolNode[] = [];
    for (const node of this.nodes.values()) {
      if (this.isSymbolNode(node)) {
        symbols.push(node);
      }
    }
    return symbols;
  }

  /**
   * Add a directed edge between two nodes.
   * Default weights: containment: 1.0, import: 0.8, call: 0.5, inheritance: 0.7, type_ref: 0.4.
   */
  public addEdge(from: string, to: string, kind: EdgeKind, weight?: number): GraphEdge {
    const edgeWeight = weight !== undefined ? weight : (DEFAULT_EDGE_WEIGHTS[kind] ?? 1.0);
    const edge: GraphEdge = {
      from,
      to,
      kind,
      weight: edgeWeight,
    };

    let outList = this.outEdges.get(from);
    if (!outList) {
      outList = [];
      this.outEdges.set(from, outList);
    }
    outList.push(edge);

    let inList = this.inEdges.get(to);
    if (!inList) {
      inList = [];
      this.inEdges.set(to, inList);
    }
    inList.push(edge);

    return edge;
  }

  public getOutEdges(id: string): GraphEdge[] {
    return this.outEdges.get(id) ?? [];
  }

  public getInEdges(id: string): GraphEdge[] {
    return this.inEdges.get(id) ?? [];
  }

  public getOutWeight(id: string): number {
    const edges = this.outEdges.get(id);
    if (!edges || edges.length === 0) return 0;
    return edges.reduce((sum, e) => sum + e.weight, 0);
  }

  public getInWeight(id: string): number {
    const edges = this.inEdges.get(id);
    if (!edges || edges.length === 0) return 0;
    return edges.reduce((sum, e) => sum + e.weight, 0);
  }

  /**
   * Resolves the canonical file ID (`file:<path>`) for any node ID (file or symbol).
   */
  public getFileId(nodeId: string): string {
    const node = this.nodes.get(nodeId);
    if (node) {
      if ('fileId' in node && typeof node.fileId === 'string') {
        return node.fileId;
      }
      if ('filePath' in node && typeof node.filePath === 'string') {
        return toFileNodeId(node.filePath);
      }
      if ('path' in node && typeof node.path === 'string') {
        return toFileNodeId(node.path);
      }
    }

    // Match symbol ID pattern: file:<path>:<line>:<name>
    const symbolMatch = nodeId.match(/^(file:.+):(\d+):([^:]+)$/);
    if (symbolMatch) {
      return symbolMatch[1];
    }

    return toFileNodeId(nodeId);
  }

  /**
   * Collapses symbol-to-symbol, file-to-symbol, symbol-to-file, and file-to-file edges
   * into aggregate file-to-file directed edge weights.
   */
  public buildCoarseFileGraph(): {
    fileIds: string[];
    adj: Map<string, Map<string, number>>;
  } {
    const fileIdSet = new Set<string>();

    // Collect file IDs from registered file nodes
    for (const file of this.getFiles()) {
      fileIdSet.add(this.getFileId(file.id));
    }

    // Collect file IDs from registered symbol nodes
    for (const sym of this.getSymbols()) {
      fileIdSet.add(this.getFileId(sym.id));
    }

    // Collect file IDs from any edge endpoints
    for (const [fromId, edges] of this.outEdges.entries()) {
      fileIdSet.add(this.getFileId(fromId));
      for (const edge of edges) {
        fileIdSet.add(this.getFileId(edge.to));
      }
    }

    const fileIds = Array.from(fileIdSet).sort();
    const adj = new Map<string, Map<string, number>>();

    for (const fileId of fileIds) {
      adj.set(fileId, new Map<string, number>());
    }

    for (const [fromId, edges] of this.outEdges.entries()) {
      const fromFile = this.getFileId(fromId);
      for (const edge of edges) {
        const toFile = this.getFileId(edge.to);
        // Exclude intra-file edges from coarse file graph
        if (fromFile !== toFile) {
          const fromMap = adj.get(fromFile);
          if (fromMap) {
            const current = fromMap.get(toFile) ?? 0;
            fromMap.set(toFile, current + edge.weight);
          }
        }
      }
    }

    return { fileIds, adj };
  }

  private isFileNode(node: SymbolNode | FileNode): node is FileNode {
    if (node.type === 'file') return true;
    if (node.type === 'symbol') return false;
    return 'path' in node && !('line' in node);
  }

  private isSymbolNode(node: SymbolNode | FileNode): node is SymbolNode {
    if (node.type === 'symbol') return true;
    if (node.type === 'file') return false;
    return 'line' in node;
  }
}
