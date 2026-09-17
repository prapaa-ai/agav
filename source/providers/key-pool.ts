export interface KeySlot {
  key: string;
  index: number;
  coolingUntil: number;
  activeRequests: number;
  totalRequests: number;
  errorCount: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  consecutiveFailures: number;
  enabled: boolean;
}

export interface KeySlotStatus {
  index: number;
  key: string;
  coolingUntil: number;
  isCooling: boolean;
  activeRequests: number;
  totalRequests: number;
  errorCount: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  consecutiveFailures: number;
  enabled: boolean;
}

export interface KeyPoolStatus {
  provider: string;
  totalKeys: number;
  availableKeys: number;
  coolingKeys: number;
  disabledKeys: number;
  enabledKeys: number;
  activeRequests: number;
  totalRequests: number;
  totalErrors: number;
  keys: KeySlotStatus[];
  slots: KeySlotStatus[];
}

/**
 * Mask secrets to prevent sensitive API keys from appearing in logs, status, or errors.
 * Example: `sk-ant-api03-abcdef1234` -> `sk-...1234`, `nvapi-12345678` -> `nva...5678`.
 */
export function maskKey(key: string): string {
  if (!key || typeof key !== "string") return "***";
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "***";
  if (trimmed.startsWith("sk-")) {
    return `sk-...${trimmed.slice(-4)}`;
  }
  return `${trimmed.slice(0, 3)}...${trimmed.slice(-4)}`;
}

export class KeyPoolManager {
  private static instance: KeyPoolManager | null = null;
  private pools = new Map<string, KeySlot[]>();
  private rrPointers = new Map<string, number>();

  private constructor() {}

  static getInstance(): KeyPoolManager {
    if (!KeyPoolManager.instance) {
      KeyPoolManager.instance = new KeyPoolManager();
    }
    return KeyPoolManager.instance;
  }

  static resetInstance(): void {
    if (KeyPoolManager.instance) {
      KeyPoolManager.instance.pools.clear();
      KeyPoolManager.instance.rrPointers.clear();
      KeyPoolManager.instance = null;
    }
  }

  /**
   * Registers a list of API keys for a given provider.
   * Duplicate, empty, or whitespace-only keys are ignored.
   * Existing statistics for keys that remain registered are preserved.
   */
  registerKeys(provider: string, keys: string[]): void {
    if (!provider) return;
    if (!Array.isArray(keys)) {
      this.pools.set(provider, []);
      return;
    }

    const validKeys: string[] = [];
    const seen = new Set<string>();

    for (const raw of keys) {
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (trimmed.length > 0 && !seen.has(trimmed)) {
          seen.add(trimmed);
          validKeys.push(trimmed);
        }
      }
    }

    const existingSlots = this.pools.get(provider) ?? [];
    const existingMap = new Map<string, KeySlot>();
    for (const s of existingSlots) {
      existingMap.set(s.key, s);
    }

    const slots: KeySlot[] = validKeys.map((key, index) => {
      const existing = existingMap.get(key);
      if (existing) {
        return {
          ...existing,
          index,
        };
      }
      return {
        key,
        index,
        coolingUntil: 0,
        activeRequests: 0,
        totalRequests: 0,
        errorCount: 0,
        consecutiveFailures: 0,
        enabled: true,
      };
    });

    this.pools.set(provider, slots);
    this.rrPointers.set(provider, 0);
  }

  /**
   * Retrieves the next available key slot for a provider.
   * Picks among non-cooling, enabled keys using least-active, failure-aware round-robin.
   */
  getNextKey(provider: string): { key: string; index: number } | null {
    const slots = this.pools.get(provider);
    if (!slots || slots.length === 0) {
      return null;
    }

    const now = Date.now();
    const available = slots.filter((s) => s.enabled && now >= s.coolingUntil);
    if (available.length === 0) {
      return null;
    }

    // 1. Select least active requests
    const minActive = Math.min(...available.map((s) => s.activeRequests));
    const candidates = available.filter((s) => s.activeRequests === minActive);

    // 2. Round-robin among candidates using nextIndex
    const nextIndex = this.rrPointers.get(provider) ?? 0;
    const selected = candidates.find((c) => c.index >= nextIndex) ?? candidates[0];

    this.rrPointers.set(provider, (selected.index + 1) % slots.length);

    selected.activeRequests++;
    selected.totalRequests++;

    return { key: selected.key, index: selected.index };
  }

  /**
   * Reports a successful request on a key slot.
   * Decrements active requests and clears consecutive failures and cooldown.
   */
  reportSuccess(provider: string, key: string): void {
    const slots = this.pools.get(provider);
    if (!slots) return;
    const slot = slots.find((s) => s.key === key);
    if (!slot) return;

    slot.activeRequests = Math.max(0, slot.activeRequests - 1);
    slot.consecutiveFailures = 0;
    slot.coolingUntil = 0;
    slot.lastSuccessAt = Date.now();
  }

  /**
   * Reports a failed request on a key slot.
   * Decrements active requests, increases consecutive failures, and applies cooldown.
   */
  reportFailure(provider: string, key: string, _err: unknown, retryAfterMs?: number): void {
    const slots = this.pools.get(provider);
    if (!slots) return;
    const slot = slots.find((s) => s.key === key);
    if (!slot) return;

    slot.activeRequests = Math.max(0, slot.activeRequests - 1);
    slot.errorCount++;
    slot.consecutiveFailures++;
    slot.lastFailureAt = Date.now();

    const now = Date.now();
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      slot.coolingUntil = now + retryAfterMs;
    } else {
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, capped at 60s
      const delay = Math.min(60_000, 1000 * Math.pow(2, slot.consecutiveFailures - 1));
      slot.coolingUntil = now + delay;
    }
  }

  /**
   * Enables or disables a specific key slot by index.
   */
  enableKey(provider: string, index: number, enabled: boolean): void {
    const slots = this.pools.get(provider);
    if (!slots) return;
    const slot = slots.find((s) => s.index === index);
    if (slot) {
      slot.enabled = enabled;
    }
  }

  /**
   * Releases an active request reservation when a request is aborted without reporting.
   */
  releaseKey(provider: string, key: string): void {
    const slots = this.pools.get(provider);
    if (!slots) return;
    const slot = slots.find((s) => s.key === key);
    if (slot) {
      slot.activeRequests = Math.max(0, slot.activeRequests - 1);
    }
  }

  /**
   * Returns current pool status with masked keys for one or all providers.
   */
  getPoolStatus(provider?: string): Record<string, KeyPoolStatus> {
    const result: Record<string, KeyPoolStatus> = {};
    const now = Date.now();

    const providers = provider
      ? this.pools.has(provider)
        ? [provider]
        : []
      : Array.from(this.pools.keys());

    for (const p of providers) {
      const slots = this.pools.get(p) ?? [];
      const keyStatuses: KeySlotStatus[] = slots.map((s) => ({
        index: s.index,
        key: maskKey(s.key),
        coolingUntil: s.coolingUntil,
        isCooling: s.coolingUntil > now,
        activeRequests: s.activeRequests,
        totalRequests: s.totalRequests,
        errorCount: s.errorCount,
        lastSuccessAt: s.lastSuccessAt,
        lastFailureAt: s.lastFailureAt,
        consecutiveFailures: s.consecutiveFailures,
        enabled: s.enabled,
      }));

      const coolingKeys = keyStatuses.filter((s) => s.isCooling).length;
      const disabledKeys = keyStatuses.filter((s) => !s.enabled).length;
      const availableKeys = keyStatuses.filter((s) => s.enabled && !s.isCooling).length;
      const activeRequests = slots.reduce((acc, s) => acc + s.activeRequests, 0);
      const totalRequests = slots.reduce((acc, s) => acc + s.totalRequests, 0);
      const totalErrors = slots.reduce((acc, s) => acc + s.errorCount, 0);

      const status: KeyPoolStatus = {
        provider: p,
        totalKeys: slots.length,
        availableKeys,
        coolingKeys,
        disabledKeys,
        enabledKeys: keyStatuses.filter((s) => s.enabled).length,
        activeRequests,
        totalRequests,
        totalErrors,
        keys: keyStatuses,
        slots: keyStatuses,
      };
      result[p] = status;
    }

    return result;
  }
}
