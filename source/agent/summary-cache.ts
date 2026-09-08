import { createHash } from "node:crypto";
import type { Message } from "../providers/types.js";

/**
 * Build a stable content signature for a set of messages, so an identical drop
 * set summarized twice (retries, error-recovery re-compaction) can reuse the
 * first result instead of paying for another provider call.
 *
 * The signature covers the parts that determine the summary — role and every
 * text / tool payload — but ignores volatile display-only fields. It also folds
 * in the model, since a different model can produce a different summary.
 */
export function hashSummaryInput(model: string, messages: Message[]): string {
  const hash = createHash("sha256");
  hash.update(model);
  hash.update("\u0000");
  for (const msg of messages) {
    hash.update(msg.role);
    hash.update("\u0001");
    for (const block of msg.content) {
      hash.update(block.type);
      hash.update("\u0002");
      if (block.text) hash.update(block.text);
      if (block.toolName) hash.update(block.toolName);
      if (block.toolCallId) hash.update(block.toolCallId);
      if (block.toolInput) hash.update(JSON.stringify(block.toolInput));
      if (block.toolResult) hash.update(block.toolResult);
      if (block.toolResultContent) hash.update(JSON.stringify(block.toolResultContent));
      hash.update("\u0003");
    }
  }
  return hash.digest("hex");
}

/**
 * A tiny bounded cache mapping a message signature to a produced summary. Scoped
 * to a single loop/command invocation, so it never persists stale summaries
 * across sessions. Only non-empty summaries are stored — an empty result means
 * the summarizer failed and must be retried, not cached.
 */
export class SummaryCache {
  private store = new Map<string, string>();
  private readonly maxEntries: number;

  constructor(maxEntries = 16) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  get(key: string): string | undefined {
    const value = this.store.get(key);
    if (value === undefined) return undefined;
    // Refresh recency: delete + re-insert moves it to the end (newest).
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  set(key: string, summary: string): void {
    if (!summary.trim()) return; // never cache an empty/failed summary
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, summary);
    // Evict the oldest entry when over capacity.
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  get size(): number {
    return this.store.size;
  }
}
