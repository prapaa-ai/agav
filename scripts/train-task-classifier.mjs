/**
 * Offline trainer for the task-difficulty classifier.
 *
 * Trains a logistic-regression model (P(hard)) over hashed n-gram features and
 * writes the weights to source/agent/task-classifier-weights.json. The runtime
 * (source/agent/linear-model.ts) loads that JSON — no native runtime needed.
 *
 * Run:  node scripts/train-task-classifier.mjs
 *
 * The feature extraction here MUST stay identical to source/agent/text-features.ts.
 * It is duplicated (not imported) so the trainer runs without a TS build step;
 * a test asserts the two implementations agree.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FEATURE_DIM = 512;

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}
const bucket = (t) => fnv1a(t) % FEATURE_DIM;
const tokenize = (text) => (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []);

function extractFeatures(text) {
  const vec = new Float64Array(FEATURE_DIM);
  const tokens = tokenize(text);
  for (const t of tokens) vec[bucket(t)] += 1;
  for (let i = 0; i + 1 < tokens.length; i++) vec[bucket(`${tokens[i]} ${tokens[i + 1]}`)] += 1;
  const structural = [
    ["__len_short", text.length < 40 ? 1 : 0],
    ["__len_med", text.length >= 40 && text.length < 200 ? 1 : 0],
    ["__len_long", text.length >= 200 ? 1 : 0],
    ["__qmark", text.includes("?") ? 1 : 0],
    ["__code", /[{};()<>]|\.[a-z]{1,4}\b|```/.test(text) ? 1 : 0],
    ["__path", /\/[\w.-]+/.test(text) ? 1 : 0],
  ];
  for (const [name, val] of structural) if (val) vec[bucket(name)] += val;
  let norm = 0;
  for (let i = 0; i < FEATURE_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < FEATURE_DIM; i++) vec[i] /= norm;
  return vec;
}

// --- Training data. label 1 = hard (needs strong model), 0 = simple. ----------
const SIMPLE = [
  "what is a closure?", "explain what a promise is", "what does async mean",
  "define idempotent", "what is a mutex", "which port does the dev server use",
  "how many providers are supported", "what is the difference between let and const",
  "explain the event loop", "what is a pure function", "who wrote this library",
  "what does REST stand for", "what is a race condition in one sentence",
  "summarize what this project does", "what is memoization", "define big o notation",
  "what is a hash map", "explain dependency injection briefly", "what is a monad",
  "what is tail recursion", "what does CORS mean", "what is a semaphore",
  "explain what a linked list is", "what is the DOM", "what is JSON",
  "what is a foreign key", "what does TDD mean", "explain what a webhook is",
  "what is latency", "what is throughput", "define idempotency",
];
const HARD = [
  "refactor the auth module to use tokens", "fix the failing test in loop.ts",
  "implement a retry wrapper with backoff", "add a new endpoint for user search",
  "debug this stack trace from production", "optimize the query in report.ts",
  "migrate the database schema to add a column", "rewrite the parser to support nesting",
  "why does main.tsx throw a null error", "write a function to merge two sorted lists",
  "add caching to the api client", "remove the deprecated flag and update callers",
  "fix the race condition in the scheduler", "implement pagination for the results list",
  "refactor conversation.ts to split compaction out", "add error handling to the upload path",
  "create a migration for the new table", "patch the security hole in the auth check",
  "update the config parser to accept arrays", "integrate the new payment provider",
  "diagnose why the build is slow", "rewrite this loop to be O(n)",
  "add a unit test for the compressor", "fix the memory leak in the watcher",
  "implement the retrieve tool for cleared results", "refactor the provider registry",
  "change the summarizer to use the fast model", "add a /cost command to the cli",
  "handle the edge case where the array is empty", "wire the classifier into the loop",
];

const data = [
  ...SIMPLE.map((t) => ({ x: extractFeatures(t), y: 0 })),
  ...HARD.map((t) => ({ x: extractFeatures(t), y: 1 })),
];

// --- Logistic regression via gradient descent with L2 regularization. ---------
const weights = new Float64Array(FEATURE_DIM);
let bias = 0;
const lr = 0.5;
const l2 = 1e-4;
const epochs = 400;
const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

for (let epoch = 0; epoch < epochs; epoch++) {
  for (const { x, y } of data) {
    let z = bias;
    for (let i = 0; i < FEATURE_DIM; i++) z += x[i] * weights[i];
    const p = sigmoid(z);
    const g = p - y;
    for (let i = 0; i < FEATURE_DIM; i++) weights[i] -= lr * (g * x[i] + l2 * weights[i]);
    bias -= lr * g;
  }
}

// --- Report training accuracy. ------------------------------------------------
let correct = 0;
for (const { x, y } of data) {
  let z = bias;
  for (let i = 0; i < FEATURE_DIM; i++) z += x[i] * weights[i];
  if ((sigmoid(z) >= 0.5 ? 1 : 0) === y) correct++;
}
console.log(`Training accuracy: ${((correct / data.length) * 100).toFixed(1)}% (${correct}/${data.length})`);

// --- Write weights JSON. ------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "source", "agent", "task-classifier-weights.json");
const model = {
  dim: FEATURE_DIM,
  weights: Array.from(weights).map((w) => Number(w.toFixed(6))),
  bias: Number(bias.toFixed(6)),
  version: "1",
  trainedOn: new Date().toISOString().slice(0, 10),
};
fs.writeFileSync(out, JSON.stringify(model));
console.log(`Wrote ${out} (${data.length} examples, dim ${FEATURE_DIM})`);
