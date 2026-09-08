# Task-Classifier Training Dataset — Engineering Notes

> **Internal / contributor doc.** Describes how the per-turn task-difficulty
> classifier is trained and how to improve it. Not published to docs.agav.dev.

The optional per-turn model router (`autoRouteTurns`) uses a small
logistic-regression classifier that runs in pure TypeScript inside the binary
(`source/agent/linear-model.ts` + `source/agent/text-features.ts`). The weights
ship as `source/agent/task-classifier-weights.json` and are produced offline by
`scripts/train-task-classifier.mjs`.

## The label

Each example is a **user turn text** labeled:

- `0` = **simple** — a lookup/explanation/definition that does not touch code and
  needs no multi-step reasoning (safe to route to the cheap model tier).
- `1` = **hard** — anything that might edit code, debug, design, or requires
  real reasoning (must stay on the user's configured strong model).

When in doubt, label **hard**. The cost of misrouting a hard task to a weak model
(bad code) far exceeds the cost of running a simple turn on the strong model.

## Current dataset

The shipped model is trained on a **small seed set embedded in the trainer**
(`scripts/train-task-classifier.mjs`, the `SIMPLE` and `HARD` arrays) — ~30
examples per class. It reaches 100% training accuracy and generalizes on the
held-out phrasings asserted in `source/__tests__/agent.linear-model.test.ts`.

This seed set is intentionally minimal: it makes the feature pipeline and the
in-binary model real and testable, and the heuristic safety gate
(`classifyHeuristic`) backstops any model miss. It is **not** a production-grade
corpus.

## Improving accuracy — the recommended path

Accuracy scales with data, not code. To improve routing quality:

1. **Collect real labeled turns.** The best source is your own transcripts. For
   each user turn, label it by outcome: did the turn (or the tool cycle it
   started) end up editing code / running commands that changed state? If yes →
   `hard`; if it was answered with information only → `simple`.
   - A cheap way to bootstrap labels: mark a turn `hard` if the resulting
     assistant turn called `edit_file` / `write_file` / `run_command`, else
     `simple`. Hand-correct the obvious mistakes.
2. **Grow the trainer's dataset.** Add the examples to the `SIMPLE` / `HARD`
   arrays in `scripts/train-task-classifier.mjs`, or (preferred at scale) change
   the trainer to read a `dataset.jsonl` of `{ "text": "...", "label": 0|1 }`
   lines so the corpus lives outside code.
3. **Retrain:** `pnpm train:classifier`. It rewrites the weights JSON and prints
   training accuracy.
4. **Guard against feature drift.** Feature extraction is duplicated in the
   trainer script and `source/agent/text-features.ts`. If you change one, change
   both; the held-out test in `agent.linear-model.test.ts` will fail if the
   shipped weights no longer classify held-out phrasings correctly.
5. **Validate before shipping.** Keep a held-out set (do not train on it) and
   report accuracy on it. Only ship weights that beat the previous version on the
   held-out set.

## Data hygiene

- **Never commit real user prompts** that contain secrets, proprietary code, or
  PII into the trainer or a checked-in dataset. Prefer paraphrased or synthetic
  examples for the committed corpus; keep any private corpus out of the repo.
- The classifier only decides *which model tier* handles a turn — a wrong call is
  a cost/quality trade, never a correctness or safety issue, because the safety
  gate and the opt-in default (`autoRouteTurns: false`) bound the blast radius.

## Why not a bigger model (DeBERTa/MiniLM via ONNX)

A transformer encoder would classify more accurately, but it requires a native
ONNX runtime or WASM — incompatible with Agav's self-contained single-binary
distribution and a large size cost. The logistic-regression-over-hashed-features
model gives most of the value at a few KB with zero native dependency. If a
transformer is ever wanted, it should be strictly opt-in (download-on-demand),
never a hard dependency.
