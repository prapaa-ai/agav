/**
 * Deterministic text -> fixed-size feature vector, using the hashing trick.
 * Shared by the offline trainer and the in-binary classifier so features are
 * identical on both sides. Pure TS, no dependencies.
 *
 * Features: lowercased word unigrams + bigrams + a few cheap structural signals
 * (length bucket, has-question-mark, has-code-punctuation), hashed into a fixed
 * number of buckets. This keeps the model tiny and the runtime allocation-free
 * beyond one Float array.
 */

export const FEATURE_DIM = 512;

/** FNV-1a 32-bit hash — small, fast, dependency-free, stable across runs. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts to stay in int range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function bucket(token: string): number {
  return fnv1a(token) % FEATURE_DIM;
}

/** Tokenize into lowercased word tokens. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
}

/**
 * Build a sparse-ish dense feature vector of length FEATURE_DIM. Values are
 * counts, then L2-normalized so long and short inputs are comparable.
 */
export function extractFeatures(text: string): Float64Array {
  const vec = new Float64Array(FEATURE_DIM);
  const tokens = tokenize(text);

  // Unigrams.
  for (const t of tokens) vec[bucket(t)] += 1;
  // Bigrams.
  for (let i = 0; i + 1 < tokens.length; i++) {
    vec[bucket(`${tokens[i]} ${tokens[i + 1]}`)] += 1;
  }

  // Cheap structural signals folded into dedicated buckets (namespaced so they
  // don't collide with word hashes by construction — they still land in-range).
  const structural: Array<[string, number]> = [
    ["__len_short", text.length < 40 ? 1 : 0],
    ["__len_med", text.length >= 40 && text.length < 200 ? 1 : 0],
    ["__len_long", text.length >= 200 ? 1 : 0],
    ["__qmark", text.includes("?") ? 1 : 0],
    ["__code", /[{};()<>]|\.[a-z]{1,4}\b|```/.test(text) ? 1 : 0],
    ["__path", /\/[\w.-]+/.test(text) ? 1 : 0],
  ];
  for (const [name, val] of structural) {
    if (val) vec[bucket(name)] += val;
  }

  // L2 normalize.
  let norm = 0;
  for (let i = 0; i < FEATURE_DIM; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < FEATURE_DIM; i++) vec[i]! /= norm;
  }
  return vec;
}
