import { DirectedSymbolGraph, SymbolNode } from './symbol-graph.js';

export interface PageRankOptions {
  alpha?: number;
  epsilon?: number;
  maxIterations?: number;
  normalization?: 'max' | 'sum';
  method?: 'power-iteration' | 'forward-push';
}

const DEFAULT_ALPHA = 0.85;
const DEFAULT_EPSILON = 1e-6;
const DEFAULT_MAX_ITERATIONS = 100;

/**
 * Compute global two-level hierarchical PageRank:
 * 1. Coarse Level: Power iteration on coarse file graph with uniform personalization
 *    v_i = 1 / |F| and column stochastic normalization M_ij = A_ij / d_j.
 *    Dangling nodes (d_j = 0) distribute mass uniformly to v.
 * 2. Fine Level: Redistribute file score down to individual symbols:
 *    p(s) = p(f) * (0.7 * (w_in(s) / (sum w_in + 1e-6)) + 0.3 * (1 / |S_f|)) * (s.exported ? 1.25 : 1.0)
 * 3. Normalize all scores (default: max score = 1.0).
 */
export function computeGlobalPageRank(
  graph: DirectedSymbolGraph,
  options?: PageRankOptions
): Map<string, number> {
  const alpha = options?.alpha ?? DEFAULT_ALPHA;
  const epsilon = options?.epsilon ?? DEFAULT_EPSILON;
  const maxIterations = options?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const normalization = options?.normalization ?? 'max';

  const { fileIds, adj } = graph.buildCoarseFileGraph();
  const nFiles = fileIds.length;
  const scores = new Map<string, number>();

  if (nFiles === 0) {
    return scores;
  }

  // 1. Coarse Level: Power iteration on files
  const outDegrees = new Map<string, number>();
  for (const fId of fileIds) {
    const targetMap = adj.get(fId);
    let d = 0;
    if (targetMap) {
      for (const w of targetMap.values()) {
        d += w;
      }
    }
    outDegrees.set(fId, d);
  }

  // Uniform personalization vector v
  const v = 1.0 / nFiles;
  let p = new Map<string, number>();
  for (const fId of fileIds) {
    p.set(fId, v);
  }

  for (let iter = 0; iter < maxIterations; iter++) {
    // Collect dangling node mass (files with out-degree = 0)
    let danglingMass = 0;
    for (const fId of fileIds) {
      if ((outDegrees.get(fId) ?? 0) === 0) {
        danglingMass += p.get(fId) ?? 0;
      }
    }

    const nextP = new Map<string, number>();
    const base = (1.0 - alpha) * v + alpha * danglingMass * v;
    for (const i of fileIds) {
      nextP.set(i, base);
    }
    for (const [j, targets] of adj.entries()) {
      const dj = outDegrees.get(j) ?? 0;
      if (dj <= 0) continue;
      const pj = p.get(j) ?? 0;
      if (pj === 0) continue;
      for (const [i, aij] of targets.entries()) {
        if (aij <= 0) continue;
        nextP.set(i, (nextP.get(i) ?? 0) + alpha * (aij / dj) * pj);
      }
    }
    let diff = 0;
    for (const i of fileIds) {
      diff += Math.abs((nextP.get(i) ?? 0) - (p.get(i) ?? 0));
    }

    p = nextP;
    if (diff < epsilon) {
      break;
    }
  }

  // 2. Fine Level: Redistribute file scores to symbols
  redistributeFileScoresToSymbols(graph, fileIds, p, scores);

  // 3. Normalization
  normalizeScores(scores, normalization);

  return scores;
}

/**
 * Compute Personalized PageRank (PPR) focused on seed files.
 * Uses Andersen-Chung-Lang Forward-Push local approximation or targeted power iteration.
 */
export function computePersonalizedPageRank(
  graph: DirectedSymbolGraph,
  seedFiles: string[],
  options?: PageRankOptions
): Map<string, number> {
  const alpha = options?.alpha ?? DEFAULT_ALPHA;
  const epsilon = options?.epsilon ?? DEFAULT_EPSILON;
  const maxIterations = options?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const normalization = options?.normalization ?? 'max';
  const method = options?.method ?? 'forward-push';

  const { fileIds, adj } = graph.buildCoarseFileGraph();
  const nFiles = fileIds.length;
  const scores = new Map<string, number>();

  if (nFiles === 0) {
    return scores;
  }

  // Normalize seed file IDs and filter to existing files
  const validSeeds: string[] = [];
  const seedSet = new Set<string>();
  for (const seed of seedFiles) {
    const fileId = graph.getFileId(seed);
    if (fileIds.includes(fileId) && !seedSet.has(fileId)) {
      seedSet.add(fileId);
      validSeeds.push(fileId);
    }
  }

  // Personalized seed vector v
  const v = new Map<string, number>();
  if (validSeeds.length > 0) {
    const seedWeight = 1.0 / validSeeds.length;
    for (const fId of fileIds) {
      v.set(fId, seedSet.has(fId) ? seedWeight : 0);
    }
  } else {
    // Fall back to uniform if no valid seeds
    const uniform = 1.0 / nFiles;
    for (const fId of fileIds) {
      v.set(fId, uniform);
    }
  }

  // Out-degrees of files
  const outDegrees = new Map<string, number>();
  for (const fId of fileIds) {
    const targetMap = adj.get(fId);
    let d = 0;
    if (targetMap) {
      for (const w of targetMap.values()) {
        d += w;
      }
    }
    outDegrees.set(fId, d);
  }

  let fileScores = new Map<string, number>();

  if (method === 'power-iteration') {
    // Targeted Power Iteration with personalized seed vector v
    let p = new Map<string, number>(v);

    for (let iter = 0; iter < maxIterations; iter++) {
      let danglingMass = 0;
      for (const fId of fileIds) {
        if ((outDegrees.get(fId) ?? 0) === 0) {
          danglingMass += p.get(fId) ?? 0;
        }
      }

      const nextP = new Map<string, number>();
      for (const i of fileIds) {
        const vi = v.get(i) ?? 0;
        nextP.set(i, (1.0 - alpha) * vi + alpha * danglingMass * vi);
      }
      for (const [j, targets] of adj.entries()) {
        const dj = outDegrees.get(j) ?? 0;
        if (dj <= 0) continue;
        const pj = p.get(j) ?? 0;
        if (pj === 0) continue;
        for (const [i, aij] of targets.entries()) {
          if (aij <= 0) continue;
          nextP.set(i, (nextP.get(i) ?? 0) + alpha * (aij / dj) * pj);
        }
      }
      let diff = 0;
      for (const i of fileIds) {
        diff += Math.abs((nextP.get(i) ?? 0) - (p.get(i) ?? 0));
      }

      p = nextP;
      if (diff < epsilon) {
        break;
      }
    }
    fileScores = p;
  } else {
    // Andersen-Chung-Lang (ACL) Forward-Push local approximation
    const p = new Map<string, number>();
    const r = new Map<string, number>();

    for (const fId of fileIds) {
      p.set(fId, 0);
      r.set(fId, v.get(fId) ?? 0);
    }

    const queue: string[] = [];
    for (const fId of fileIds) {
      if ((r.get(fId) ?? 0) >= epsilon) {
        queue.push(fId);
      }
    }

    const maxPushes = maxIterations * nFiles * 5;
    let pushes = 0;

    while (queue.length > 0 && pushes < maxPushes) {
      const u = queue.shift()!;
      const ru = r.get(u) ?? 0;
      if (ru < epsilon) {
        continue;
      }

      pushes++;
      r.set(u, 0);

      // Convert (1 - alpha) fraction of residual into permanent PageRank
      p.set(u, (p.get(u) ?? 0) + (1.0 - alpha) * ru);

      const pushMass = alpha * ru;
      const du = outDegrees.get(u) ?? 0;

      if (du > 0) {
        const targetMap = adj.get(u);
        if (targetMap) {
          for (const [w, weight] of targetMap.entries()) {
            const delta = pushMass * (weight / du);
            const nextR = (r.get(w) ?? 0) + delta;
            r.set(w, nextR);
            if (nextR >= epsilon) {
              queue.push(w);
            }
          }
        }
      } else {
        // Dangling node: push back according to personalization vector v
        for (const [targetId, vProb] of v.entries()) {
          if (vProb > 0) {
            const delta = pushMass * vProb;
            const nextR = (r.get(targetId) ?? 0) + delta;
            r.set(targetId, nextR);
            if (nextR >= epsilon) {
              queue.push(targetId);
            }
          }
        }
      }
    }

    // Distribute any remaining residual mass
    for (const fId of fileIds) {
      const remainingR = r.get(fId) ?? 0;
      p.set(fId, (p.get(fId) ?? 0) + (1.0 - alpha) * remainingR);
    }

    fileScores = p;
  }

  // 2. Fine Level: Redistribute file scores to symbols
  redistributeFileScoresToSymbols(graph, fileIds, fileScores, scores);

  // 3. Normalization
  normalizeScores(scores, normalization);

  return scores;
}

/**
 * Redistributes file scores down to individual symbols:
 * p(s) = p(f) * (0.7 * (w_in(s) / (sum w_in + 1e-6)) + 0.3 * (1 / |S_f|)) * (s.exported ? 1.25 : 1.0)
 */
function redistributeFileScoresToSymbols(
  graph: DirectedSymbolGraph,
  fileIds: string[],
  fileScores: Map<string, number>,
  scores: Map<string, number>
): void {
  const allSymbols = graph.getSymbols();

  // Group symbols by file ID
  const symbolsByFile = new Map<string, SymbolNode[]>();
  for (const fId of fileIds) {
    symbolsByFile.set(fId, []);
  }

  for (const sym of allSymbols) {
    const fileId = graph.getFileId(sym.id);
    let list = symbolsByFile.get(fileId);
    if (!list) {
      list = [];
      symbolsByFile.set(fileId, list);
    }
    list.push(sym);
  }

  for (const fId of fileIds) {
    const pf = fileScores.get(fId) ?? 0;
    scores.set(fId, pf);

    const sList = symbolsByFile.get(fId) ?? [];
    const sfCount = sList.length;
    if (sfCount === 0) {
      continue;
    }

    let sumWin = 0;
    for (const sym of sList) {
      sumWin += graph.getInWeight(sym.id);
    }

    for (const sym of sList) {
      const win = graph.getInWeight(sym.id);
      const degreeTerm = 0.7 * (win / (sumWin + 1e-6));
      const uniformTerm = 0.3 * (1.0 / sfCount);
      const exportMultiplier = sym.exported ? 1.25 : 1.0;

      const ps = pf * (degreeTerm + uniformTerm) * exportMultiplier;
      scores.set(sym.id, ps);
    }
  }
}

/**
 * Normalizes scores in-place:
 * - 'max': highest score is 1.0
 * - 'sum': sum of all scores is 1.0
 */
function normalizeScores(scores: Map<string, number>, mode: 'max' | 'sum'): void {
  if (scores.size === 0) return;

  if (mode === 'sum') {
    let sum = 0;
    for (const val of scores.values()) {
      sum += val;
    }
    if (sum > 0) {
      for (const [k, val] of scores.entries()) {
        scores.set(k, val / sum);
      }
    }
  } else {
    let maxVal = 0;
    for (const val of scores.values()) {
      if (val > maxVal) maxVal = val;
    }
    if (maxVal > 0) {
      for (const [k, val] of scores.entries()) {
        scores.set(k, val / maxVal);
      }
    }
  }
}
