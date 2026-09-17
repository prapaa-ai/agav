import { describe, expect, it } from 'vitest';
import { DirectedSymbolGraph } from '../repomap/graph/symbol-graph.js';
import {
  computeGlobalPageRank,
  computePersonalizedPageRank,
} from '../repomap/graph/pagerank.js';

describe('PageRank Algorithms', () => {
  it('converges properly and adheres to maxIterations and epsilon', () => {
    const graph = new DirectedSymbolGraph();
    graph.addFileNode({ path: 'src/a.ts' });
    graph.addFileNode({ path: 'src/b.ts' });
    graph.addFileNode({ path: 'src/c.ts' });

    graph.addEdge('file:src/a.ts', 'file:src/b.ts', 'import', 1.0);
    graph.addEdge('file:src/b.ts', 'file:src/c.ts', 'import', 1.0);
    graph.addEdge('file:src/c.ts', 'file:src/a.ts', 'import', 1.0);

    const scores = computeGlobalPageRank(graph, {
      alpha: 0.85,
      epsilon: 1e-7,
      maxIterations: 100,
    });

    // In a symmetric cycle, all files should receive identical rank
    const sa = scores.get('file:src/a.ts')!;
    const sb = scores.get('file:src/b.ts')!;
    const sc = scores.get('file:src/c.ts')!;

    expect(sa).toBeCloseTo(1.0);
    expect(sb).toBeCloseTo(1.0);
    expect(sc).toBeCloseTo(1.0);
  });

  it('demonstrates effect of damping factor alpha=0.85 vs lower alpha', () => {
    // Chain: A -> B -> C (A links to B, B links to C, C is sink)
    const graph = new DirectedSymbolGraph();
    graph.addFileNode({ path: 'src/a.ts' });
    graph.addFileNode({ path: 'src/b.ts' });
    graph.addFileNode({ path: 'src/c.ts' });

    graph.addEdge('file:src/a.ts', 'file:src/b.ts', 'import', 1.0);
    graph.addEdge('file:src/b.ts', 'file:src/c.ts', 'import', 1.0);

    const scoresHighAlpha = computeGlobalPageRank(graph, {
      alpha: 0.85,
      normalization: 'sum',
    });
    const scoresLowAlpha = computeGlobalPageRank(graph, {
      alpha: 0.20,
      normalization: 'sum',
    });

    // With higher alpha, link propagation is stronger, so C gets a higher share of rank
    const scHigh = scoresHighAlpha.get('file:src/c.ts')!;
    const scLow = scoresLowAlpha.get('file:src/c.ts')!;
    expect(scHigh).toBeGreaterThan(scLow);

    // With lower alpha, random teleportation dominates, keeping scores closer to uniform (1/3)
    const saLow = scoresLowAlpha.get('file:src/a.ts')!;
    const saHigh = scoresHighAlpha.get('file:src/a.ts')!;
    expect(saLow).toBeGreaterThan(saHigh);
  });

  it('handles dangling nodes without leaking probability mass', () => {
    const graph = new DirectedSymbolGraph();
    graph.addFileNode({ path: 'src/entry.ts' });
    graph.addFileNode({ path: 'src/leaf1.ts' });
    graph.addFileNode({ path: 'src/leaf2.ts' });

    // Entry points to two leaves, leaves point nowhere (dangling nodes)
    graph.addEdge('file:src/entry.ts', 'file:src/leaf1.ts', 'import', 1.0);
    graph.addEdge('file:src/entry.ts', 'file:src/leaf2.ts', 'import', 1.0);

    const scores = computeGlobalPageRank(graph, {
      alpha: 0.85,
      normalization: 'sum',
    });

    // Sum of file scores should equal 1.0 (no mass lost)
    const sEntry = scores.get('file:src/entry.ts')!;
    const sLeaf1 = scores.get('file:src/leaf1.ts')!;
    const sLeaf2 = scores.get('file:src/leaf2.ts')!;

    expect(sEntry + sLeaf1 + sLeaf2).toBeCloseTo(1.0, 5);
    // Entry distributes to leaves, so leaves have higher rank than entry
    expect(sLeaf1).toBeGreaterThan(sEntry);
    expect(sLeaf2).toBeGreaterThan(sEntry);
    expect(sLeaf1).toBeCloseTo(sLeaf2);
  });

  it('redistributes file scores to symbols using in-degree and export multiplier', () => {
    const graph = new DirectedSymbolGraph();
    graph.addFileNode({ path: 'src/math.ts' });
    graph.addFileNode({ path: 'src/client.ts' });

    const symAdd = graph.addSymbolNode({
      filePath: 'src/math.ts',
      name: 'add',
      line: 1,
      exported: true,
    });
    const symSub = graph.addSymbolNode({
      filePath: 'src/math.ts',
      name: 'sub',
      line: 5,
      exported: false,
    });
    const symClient = graph.addSymbolNode({
      filePath: 'src/client.ts',
      name: 'run',
      line: 1,
      exported: true,
    });

    // Client calls 'add' (weight 0.5) twice, but never calls 'sub'
    graph.addEdge(symClient.id, symAdd.id, 'call', 0.5);
    graph.addEdge('file:src/client.ts', symAdd.id, 'call', 0.5);

    const scores = computeGlobalPageRank(graph, { normalization: 'max' });

    const scoreAdd = scores.get(symAdd.id)!;
    const scoreSub = scores.get(symSub.id)!;

    // 'add' has in-weight = 1.0, 'sub' has in-weight = 0.0
    // 'add' is also exported (1.25x multiplier)
    expect(scoreAdd).toBeGreaterThan(scoreSub);
    expect(scoreAdd / scoreSub).toBeGreaterThan(2.0);
  });

  it('boosts symbols connected to seeds in Personalized PageRank (PPR)', () => {
    const graph = new DirectedSymbolGraph();

    // Two distinct subsystems: Auth (A) and Payments (B)
    graph.addFileNode({ path: 'src/auth/login.ts' });
    graph.addFileNode({ path: 'src/auth/jwt.ts' });
    graph.addFileNode({ path: 'src/pay/checkout.ts' });
    graph.addFileNode({ path: 'src/pay/stripe.ts' });

    const loginSym = graph.addSymbolNode({
      filePath: 'src/auth/login.ts',
      name: 'loginUser',
      line: 10,
      exported: true,
    });
    const jwtSym = graph.addSymbolNode({
      filePath: 'src/auth/jwt.ts',
      name: 'signToken',
      line: 5,
      exported: true,
    });
    const checkoutSym = graph.addSymbolNode({
      filePath: 'src/pay/checkout.ts',
      name: 'processCheckout',
      line: 20,
      exported: true,
    });
    const stripeSym = graph.addSymbolNode({
      filePath: 'src/pay/stripe.ts',
      name: 'chargeCard',
      line: 15,
      exported: true,
    });

    // Auth internal connections
    graph.addEdge(loginSym.id, jwtSym.id, 'call', 1.0);
    // Pay internal connections
    graph.addEdge(checkoutSym.id, stripeSym.id, 'call', 1.0);

    // Compute PPR seeded with login.ts using forward-push
    const pprForwardPush = computePersonalizedPageRank(
      graph,
      ['src/auth/login.ts'],
      { method: 'forward-push', alpha: 0.85 }
    );

    const loginScore = pprForwardPush.get(loginSym.id)!;
    const jwtScore = pprForwardPush.get(jwtSym.id)!;
    const checkoutScore = pprForwardPush.get(checkoutSym.id) ?? 0;
    const stripeScore = pprForwardPush.get(stripeSym.id) ?? 0;

    // Auth cluster must be heavily boosted over Payments cluster
    expect(loginScore).toBeGreaterThan(checkoutScore * 5);
    expect(jwtScore).toBeGreaterThan(stripeScore * 5);

    // Test targeted power-iteration method as well
    const pprPowerIter = computePersonalizedPageRank(
      graph,
      ['file:src/auth/login.ts'],
      { method: 'power-iteration', alpha: 0.85 }
    );

    expect(pprPowerIter.get(loginSym.id)!).toBeGreaterThan(pprPowerIter.get(checkoutSym.id)! * 2);
    expect(pprPowerIter.get(jwtSym.id)!).toBeGreaterThan(pprPowerIter.get(stripeSym.id)! * 2);
  });

  it('supports max and sum normalization options', () => {
    const graph = new DirectedSymbolGraph();
    graph.addFileNode({ path: 'src/a.ts' });
    graph.addFileNode({ path: 'src/b.ts' });
    graph.addEdge('file:src/a.ts', 'file:src/b.ts', 'import', 1.0);

    const maxScores = computeGlobalPageRank(graph, { normalization: 'max' });
    const maxVal = Math.max(...maxScores.values());
    expect(maxVal).toBeCloseTo(1.0);

    const sumScores = computeGlobalPageRank(graph, { normalization: 'sum' });
    let totalSum = 0;
    for (const val of sumScores.values()) {
      totalSum += val;
    }
    expect(totalSum).toBeCloseTo(1.0);
  });
});
