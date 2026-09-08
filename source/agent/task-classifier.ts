/**
 * Per-turn task-difficulty classification used for optional automatic model
 * routing. The goal is to route obviously-simple turns (lookups, explanations,
 * formatting) to a cheap model while keeping anything that might edit code or
 * require reasoning on the user's chosen (strong) model.
 *
 * Design principle: **fail safe toward "hard".** A simple turn misrouted to the
 * strong model only costs a little more; a hard turn misrouted to a weak model
 * produces bad code. So we only return "simple" when confident, and default to
 * "hard" on any doubt.
 *
 * Two layers:
 *  1. A dependency-free heuristic (always available, synchronous).
 *  2. A pure-TypeScript logistic-regression model (`classifyWithModel`) trained
 *     offline and shipped as a small JSON weights file. It runs in the
 *     self-contained binary with no native runtime and no WASM. The heuristic
 *     stays as a **safety gate**: if the model says "simple" but the heuristic
 *     sees a code/error/action signal, we keep "hard".
 */

export type TaskDifficulty = "simple" | "hard";

export interface TaskClassification {
  difficulty: TaskDifficulty;
  /** 0..1 — how confident we are in a "simple" verdict. */
  confidence: number;
  reason: string;
}

// Signals that a turn will change code or need real reasoning → keep on strong.
const HARD_KEYWORDS = [
  "refactor", "implement", "architect", "design", "debug", "fix", "optimize",
  "migrate", "rewrite", "redesign", "build", "create", "add", "remove",
  "delete", "modify", "change", "update", "patch", "edit", "write", "test",
  "deploy", "configure", "integrate", "review", "audit", "diagnose",
  "concurrency", "race condition", "deadlock", "performance", "security",
  "algorithm", "data structure", "regression", "root cause",
];

// Signals that a turn is a quick lookup/answer → candidate for the cheap model.
const SIMPLE_LEADS = [
  "what is", "what are", "what does", "what's", "who is", "when",
  "where is", "which", "explain", "describe", "summarize", "define",
  "list", "show me", "how many", "does ", "is there", "can you tell",
];

// Anything mentioning specific code artifacts leans hard.
const CODE_ARTIFACT = /(\.[a-z]{1,4}\b|\bfunction\b|\bclass\b|\bimport\b|```|\/[\w.-]+\/|\berror\b|\bstack ?trace\b|\bexception\b)/i;

/**
 * Fast, synchronous, dependency-free difficulty heuristic. Returns "simple"
 * only for short, question-shaped turns with no code/action signals.
 */
export function classifyHeuristic(text: string): TaskClassification {
  const t = text.trim().toLowerCase();

  if (t.length === 0) {
    return { difficulty: "hard", confidence: 0, reason: "empty input — default hard" };
  }

  // Long inputs almost always carry real work or context.
  if (t.length > 400) {
    return { difficulty: "hard", confidence: 0, reason: "long input" };
  }

  // Explicit code / error / path artifacts → hard.
  if (CODE_ARTIFACT.test(text)) {
    return { difficulty: "hard", confidence: 0, reason: "mentions code artifact" };
  }

  // Action verbs anywhere → hard.
  for (const kw of HARD_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`, "i").test(t)) {
      return { difficulty: "hard", confidence: 0, reason: `action keyword: ${kw}` };
    }
  }

  // Question-shaped and short → simple, with confidence scaled by brevity.
  const startsQuestion = SIMPLE_LEADS.some((lead) => t.startsWith(lead));
  const endsQuestion = t.endsWith("?");
  if (startsQuestion || endsQuestion) {
    // Shorter = more confident it's a trivial lookup.
    const confidence = t.length < 80 ? 0.9 : t.length < 200 ? 0.75 : 0.6;
    return { difficulty: "simple", confidence, reason: "question-shaped, no action signals" };
  }

  // Anything else: not confidently simple → hard.
  return { difficulty: "hard", confidence: 0, reason: "no simple signal" };
}

import { LinearClassifier, parseModelWeights } from "./linear-model.js";

/**
 * Lazily-loaded singleton classifier built from the bundled weights JSON.
 * `null` once we've tried and failed (or no weights), so we never retry the
 * import on every call. Loading is dynamic so the weights are only pulled in
 * when turn routing is actually used.
 */
let cachedClassifier: LinearClassifier | null | undefined;

async function getModelClassifier(): Promise<LinearClassifier | null> {
  if (cachedClassifier !== undefined) return cachedClassifier;
  try {
    const mod = await import("./task-classifier-weights.json", {
      with: { type: "json" },
    });
    const weights = parseModelWeights((mod as { default?: unknown }).default ?? mod);
    cachedClassifier = weights ? new LinearClassifier(weights) : null;
  } catch {
    cachedClassifier = null;
  }
  return cachedClassifier;
}

/**
 * Model-backed classification (pure TypeScript). Loads the bundled logistic-
 * regression weights and predicts P(hard); if the model is unavailable or
 * malformed, falls back to the heuristic. The heuristic also acts as a safety
 * gate: a model "simple" verdict is overridden to "hard" whenever the heuristic
 * detects a code/error/action signal, so a model miss never routes a real code
 * task to a weak model.
 */
export async function classifyWithModel(text: string): Promise<TaskClassification> {
  const heuristic = classifyHeuristic(text);
  const model = await getModelClassifier();
  if (!model) return heuristic;

  const pHard = model.predictHardProbability(text);
  // Model is confident it's simple.
  if (pHard < 0.5) {
    // Safety gate: never downgrade when the heuristic sees a hard signal.
    if (heuristic.difficulty === "hard") return heuristic;
    return {
      difficulty: "simple",
      confidence: 1 - pHard,
      reason: `model P(hard)=${pHard.toFixed(2)}`,
    };
  }
  return {
    difficulty: "hard",
    confidence: 0,
    reason: `model P(hard)=${pHard.toFixed(2)}`,
  };
}


