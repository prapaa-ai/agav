import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EDGE_WEIGHTS,
  DirectedSymbolGraph,
  toFileNodeId,
  toSymbolNodeId,
} from '../repomap/graph/symbol-graph.js';

describe('DirectedSymbolGraph', () => {
  it('correctly creates IDs and stores file and symbol nodes', () => {
    const graph = new DirectedSymbolGraph();

    const fileNode = graph.addFileNode({ path: 'src/index.ts' });
    expect(fileNode.id).toBe('file:src/index.ts');
    expect(fileNode.path).toBe('src/index.ts');
    expect(graph.hasNode('file:src/index.ts')).toBe(true);

    const symNode = graph.addSymbolNode({
      filePath: 'src/index.ts',
      name: 'main',
      line: 15,
      kind: 'function',
      exported: true,
    });
    expect(symNode.id).toBe('file:src/index.ts:15:main');
    expect(graph.hasNode('file:src/index.ts:15:main')).toBe(true);

    expect(graph.getNode('file:src/index.ts')).toEqual(fileNode);
    expect(graph.getNode('file:src/index.ts:15:main')).toEqual(symNode);
    expect(graph.getNode('nonexistent')).toBeUndefined();

    const files = graph.getFiles();
    expect(files).toHaveLength(1);
    expect(files[0]?.id).toBe('file:src/index.ts');

    const symbols = graph.getSymbols();
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.name).toBe('main');
  });

  it('assigns default edge weights properly', () => {
    const graph = new DirectedSymbolGraph();

    const edgeContainment = graph.addEdge('file:a.ts', 'file:a.ts:1:fn', 'containment');
    expect(edgeContainment.weight).toBe(DEFAULT_EDGE_WEIGHTS.containment);
    expect(edgeContainment.weight).toBe(1.0);

    const edgeImport = graph.addEdge('file:a.ts', 'file:b.ts', 'import');
    expect(edgeImport.weight).toBe(DEFAULT_EDGE_WEIGHTS.import);
    expect(edgeImport.weight).toBe(0.8);

    const edgeCall = graph.addEdge('file:a.ts:1:fn', 'file:b.ts:10:helper', 'call');
    expect(edgeCall.weight).toBe(DEFAULT_EDGE_WEIGHTS.call);
    expect(edgeCall.weight).toBe(0.5);

    const edgeInherit = graph.addEdge('file:a.ts:20:SubClass', 'file:b.ts:5:BaseClass', 'inheritance');
    expect(edgeInherit.weight).toBe(DEFAULT_EDGE_WEIGHTS.inheritance);
    expect(edgeInherit.weight).toBe(0.7);

    const edgeTypeRef = graph.addEdge('file:a.ts:1:fn', 'file:b.ts:30:MyType', 'type_ref');
    expect(edgeTypeRef.weight).toBe(DEFAULT_EDGE_WEIGHTS.type_ref);
    expect(edgeTypeRef.weight).toBe(0.4);

    // Custom weight overrides default
    const edgeCustom = graph.addEdge('file:a.ts', 'file:b.ts', 'call', 2.5);
    expect(edgeCustom.weight).toBe(2.5);
  });

  it('calculates in-degree, out-degree, and weights accurately in multigraph', () => {
    const graph = new DirectedSymbolGraph();

    const f1 = 'file:a.ts';
    const s1 = 'file:a.ts:5:funcA';
    const s2 = 'file:b.ts:10:funcB';

    graph.addEdge(f1, s1, 'containment'); // weight 1.0
    graph.addEdge(s1, s2, 'call', 0.5);
    graph.addEdge(s1, s2, 'type_ref', 0.4); // multigraph edge to same target

    expect(graph.getOutEdges(f1)).toHaveLength(1);
    expect(graph.getOutWeight(f1)).toBe(1.0);

    expect(graph.getOutEdges(s1)).toHaveLength(2);
    expect(graph.getOutWeight(s1)).toBeCloseTo(0.9);

    expect(graph.getInEdges(s2)).toHaveLength(2);
    expect(graph.getInWeight(s2)).toBeCloseTo(0.9);

    expect(graph.getInWeight(f1)).toBe(0);
    expect(graph.getOutWeight(s2)).toBe(0);
  });

  it('correctly projects multigraph into coarse file graph', () => {
    const graph = new DirectedSymbolGraph();

    graph.addFileNode({ path: 'src/app.ts' });
    graph.addFileNode({ path: 'src/utils.ts' });
    graph.addFileNode({ path: 'src/models.ts' });
    graph.addFileNode({ path: 'src/orphan.ts' });

    const appMain = graph.addSymbolNode({ filePath: 'src/app.ts', name: 'main', line: 10 });
    const utilHelp = graph.addSymbolNode({ filePath: 'src/utils.ts', name: 'helper', line: 5 });
    const utilFormat = graph.addSymbolNode({ filePath: 'src/utils.ts', name: 'format', line: 20 });
    const modelUser = graph.addSymbolNode({ filePath: 'src/models.ts', name: 'User', line: 1 });

    // Intra-file edges (containment) - should be excluded from coarse inter-file graph
    graph.addEdge('file:src/app.ts', appMain.id, 'containment');
    graph.addEdge('file:src/utils.ts', utilHelp.id, 'containment');
    graph.addEdge('file:src/utils.ts', utilFormat.id, 'containment');

    // Inter-file symbol calls: app.main calls utils.helper (0.5) and utils.format (0.5)
    graph.addEdge(appMain.id, utilHelp.id, 'call', 0.5);
    graph.addEdge(appMain.id, utilFormat.id, 'call', 0.5);

    // File-to-symbol import: app imports model User (0.8)
    graph.addEdge('file:src/app.ts', modelUser.id, 'import', 0.8);

    // File-to-file import: utils imports models (0.8)
    graph.addEdge('file:src/utils.ts', 'file:src/models.ts', 'import', 0.8);

    const coarse = graph.buildCoarseFileGraph();

    expect(coarse.fileIds).toEqual([
      'file:src/app.ts',
      'file:src/models.ts',
      'file:src/orphan.ts',
      'file:src/utils.ts',
    ]);

    // app.ts -> utils.ts should have aggregated weight 0.5 + 0.5 = 1.0
    const appEdges = coarse.adj.get('file:src/app.ts')!;
    expect(appEdges.get('file:src/utils.ts')).toBeCloseTo(1.0);
    // app.ts -> models.ts should have weight 0.8
    expect(appEdges.get('file:src/models.ts')).toBeCloseTo(0.8);

    // utils.ts -> models.ts should have weight 0.8
    const utilEdges = coarse.adj.get('file:src/utils.ts')!;
    expect(utilEdges.get('file:src/models.ts')).toBeCloseTo(0.8);

    // models.ts has no outgoing edges
    const modelEdges = coarse.adj.get('file:src/models.ts')!;
    expect(modelEdges.size).toBe(0);

    // orphan.ts has no outgoing or incoming edges
    const orphanEdges = coarse.adj.get('file:src/orphan.ts')!;
    expect(orphanEdges.size).toBe(0);
  });
});
