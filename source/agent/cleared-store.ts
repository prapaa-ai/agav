/**
 * CCR (reversible compression) store.
 *
 * When context editing clears an old tool result, the original text is stashed
 * here under a short id and the in-history placeholder references that id. The
 * `retrieve` tool reads from this store, so the model can pull back the *exact*
 * original bytes on demand instead of re-running the tool (deterministic, and no
 * re-execution cost).
 *
 * Scope: process-lifetime, in-memory only. Bounded with LRU eviction so a long
 * session cannot grow it without limit. Never persisted — a resumed session
 * simply won't have old originals, and `retrieve` says so and suggests re-running
 * the tool, which is the same fallback as before CCR existed.
 */

let counter = 0;

export class ClearedStore {
  private store = new Map<string, string>();
  private readonly maxEntries: number;

  constructor(maxEntries = 64) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  /** Stash an original and return the id to reference it by. */
  put(original: string): string {
    const id = `cleared-${++counter}`;
    this.store.set(id, original);
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
    return id;
  }

  /** Retrieve a stashed original, or undefined if it was never stored/evicted. */
  get(id: string): string | undefined {
    const value = this.store.get(id);
    if (value === undefined) return undefined;
    // Refresh recency so a retrieved item is less likely to be evicted next.
    this.store.delete(id);
    this.store.set(id, value);
    return value;
  }

  has(id: string): boolean {
    return this.store.has(id);
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}

/**
 * Shared singleton used by both the conversation (which writes cleared
 * originals) and the `retrieve` tool (which reads them). A single process runs
 * one interactive session, so a module-level instance is the right scope.
 */
export const clearedStore = new ClearedStore();
