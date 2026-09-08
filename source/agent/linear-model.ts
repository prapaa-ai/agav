import { extractFeatures, FEATURE_DIM } from "./text-features.js";

/**
 * A tiny logistic-regression classifier that runs in pure TypeScript — no native
 * runtime, no WASM, no model server. Weights are trained offline and shipped as
 * a small JSON blob, so a real trained model runs inside the self-contained
 * binary with zero extra dependencies.
 *
 * Output is P(hard): the probability that a turn needs the strong model.
 */

export interface LinearModelWeights {
  /** Feature dimension — must match FEATURE_DIM the weights were trained with. */
  dim: number;
  /** Per-feature weights (length === dim). */
  weights: number[];
  /** Bias term. */
  bias: number;
  /** Optional metadata for provenance. */
  version?: string;
  trainedOn?: string;
}

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

export class LinearClassifier {
  private readonly weights: Float64Array;
  private readonly bias: number;

  constructor(model: LinearModelWeights) {
    if (model.dim !== FEATURE_DIM) {
      throw new Error(
        `Model dim ${model.dim} does not match FEATURE_DIM ${FEATURE_DIM}; retrain the model.`,
      );
    }
    if (model.weights.length !== model.dim) {
      throw new Error(`Weights length ${model.weights.length} !== dim ${model.dim}.`);
    }
    this.weights = Float64Array.from(model.weights);
    this.bias = model.bias;
  }

  /** Probability that the text is a "hard" task (needs the strong model). */
  predictHardProbability(text: string): number {
    const features = extractFeatures(text);
    let z = this.bias;
    for (let i = 0; i < FEATURE_DIM; i++) z += features[i]! * this.weights[i]!;
    return sigmoid(z);
  }
}

/**
 * Validate a parsed JSON object as model weights. Returns the model or null so
 * a malformed/mismatched file degrades to the heuristic instead of crashing.
 */
export function parseModelWeights(data: unknown): LinearModelWeights | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.dim !== "number") return null;
  if (typeof obj.bias !== "number") return null;
  if (!Array.isArray(obj.weights)) return null;
  if (obj.weights.length !== obj.dim) return null;
  if (!obj.weights.every((w) => typeof w === "number" && Number.isFinite(w))) return null;
  if (obj.dim !== FEATURE_DIM) return null;
  return {
    dim: obj.dim,
    weights: obj.weights as number[],
    bias: obj.bias,
    version: typeof obj.version === "string" ? obj.version : undefined,
    trainedOn: typeof obj.trainedOn === "string" ? obj.trainedOn : undefined,
  };
}
