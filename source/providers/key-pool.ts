export interface KeySlot {
  key: string;
  index: number;
  coolingUntil: number; // timestamp in ms, 0 if healthy
  activeRequests: number;
  totalRequests: number;
  errorCount: number;
}

export class KeyPoolManager {
  private static instance?: KeyPoolManager;
  private pools = new Map<string, KeySlot[]>();
  private cursors = new Map<string, number>();

  private constructor() {}

  static getInstance(): KeyPoolManager {
    if (!KeyPoolManager.instance) {
      KeyPoolManager.instance = new KeyPoolManager();
    }
    return KeyPoolManager.instance;
  }

  static resetInstance(): void {
    KeyPoolManager.instance = undefined;
  }

  private normalizeProvider(provider: string): string {
    return provider.trim().toLowerCase();
  }

  registerKeys(provider: string, keys: string[]): void {
    const p = this.normalizeProvider(provider);
    const existing = this.pools.get(p) ?? [];
    const existingMap = new Map<string, KeySlot>();
    for (const slot of existing) {
      existingMap.set(slot.key, slot);
    }

    // Filter empty strings and deduplicate
    const uniqueKeys: string[] = [];
    const seen = new Set<string>();
    for (const k of keys) {
      const trimmed = k.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        uniqueKeys.push(trimmed);
      }
    }

    const slots: KeySlot[] = uniqueKeys.map((key, index) => {
      const prev = existingMap.get(key);
      return {
        key,
        index,
        coolingUntil: prev?.coolingUntil ?? 0,
        activeRequests: prev?.activeRequests ?? 0,
        totalRequests: prev?.totalRequests ?? 0,
        errorCount: prev?.errorCount ?? 0,
      };
    });

    this.pools.set(p, slots);
    if (!this.cursors.has(p) || this.cursors.get(p)! >= slots.length) {
      this.cursors.set(p, 0);
    }
  }

  getKeys(provider: string): KeySlot[] {
    const p = this.normalizeProvider(provider);
    return this.pools.get(p) ?? [];
  }

  getProviders(): string[] {
    return Array.from(this.pools.keys());
  }

  hasKeys(provider: string): boolean {
    return this.getKeys(provider).length > 0;
  }

  hasHealthyKey(provider: string): boolean {
    const slots = this.getKeys(provider);
    const now = Date.now();
    return slots.some((s) => s.coolingUntil <= now);
  }

  getSoonestCooldownMs(provider: string): number {
    const slots = this.getKeys(provider);
    if (slots.length === 0) return 0;
    const now = Date.now();
    const cooling = slots.filter((s) => s.coolingUntil > now);
    if (cooling.length === 0) return 0;
    return Math.max(0, Math.min(...cooling.map((s) => s.coolingUntil - now)));
  }

  isProviderCooling(provider: string): boolean {
    const slots = this.getKeys(provider);
    if (slots.length === 0) return false;
    const now = Date.now();
    return slots.every((s) => s.coolingUntil > now);
  }

  acquireKeyByIndex(provider: string, index: number): { key: string; index: number; slot: KeySlot } {
    const p = this.normalizeProvider(provider);
    const slots = this.pools.get(p);
    if (!slots || slots.length === 0) {
      throw new Error(`No keys registered for provider "${provider}"`);
    }

    const slotIndex = ((index % slots.length) + slots.length) % slots.length;
    const chosenSlot = slots[slotIndex];
    chosenSlot.activeRequests++;
    chosenSlot.totalRequests++;

    return {
      key: chosenSlot.key,
      index: chosenSlot.index,
      slot: chosenSlot,
    };
  }

  acquireKey(provider: string): { key: string; index: number; slot: KeySlot } {
    const p = this.normalizeProvider(provider);
    const slots = this.pools.get(p);
    if (!slots || slots.length === 0) {
      throw new Error(`No keys registered for provider "${provider}"`);
    }

    const now = Date.now();
    const cursor = this.cursors.get(p) ?? 0;

    // 1. Try to find a healthy (non-cooling) key starting from current cursor
    let chosenSlot: KeySlot | null = null;
    for (let i = 0; i < slots.length; i++) {
      const idx = (cursor + i) % slots.length;
      const slot = slots[idx];
      if (slot.coolingUntil <= now) {
        chosenSlot = slot;
        this.cursors.set(p, (idx + 1) % slots.length);
        break;
      }
    }

    // 2. If all keys are in cooldown, pick the key that becomes available soonest
    if (!chosenSlot) {
      chosenSlot = slots[0];
      for (let i = 1; i < slots.length; i++) {
        if (slots[i].coolingUntil < chosenSlot.coolingUntil) {
          chosenSlot = slots[i];
        }
      }
      this.cursors.set(p, (chosenSlot.index + 1) % slots.length);
    }

    chosenSlot.activeRequests++;
    chosenSlot.totalRequests++;

    return {
      key: chosenSlot.key,
      index: chosenSlot.index,
      slot: chosenSlot,
    };
  }

  reportRateLimit(provider: string, key: string, retryAfterMs?: number): void {
    const p = this.normalizeProvider(provider);
    const slots = this.pools.get(p) ?? [];
    const slot = slots.find((s) => s.key === key);
    const cooldown = retryAfterMs ?? 30000;
    const cooldownSeconds = Math.round(cooldown / 1000);

    if (slot) {
      slot.coolingUntil = Date.now() + cooldown;
      slot.activeRequests = Math.max(0, slot.activeRequests - 1);
      slot.errorCount++;
      console.warn(`[key-pool] ${provider} key #${slot.index + 1} cooling down for ${cooldownSeconds}s`);
    } else {
      console.warn(`[key-pool] ${provider} key cooling down for ${cooldownSeconds}s`);
    }
  }

  reportSuccess(provider: string, key: string): void {
    const p = this.normalizeProvider(provider);
    const slots = this.pools.get(p) ?? [];
    const slot = slots.find((s) => s.key === key);
    if (slot) {
      slot.activeRequests = Math.max(0, slot.activeRequests - 1);
      if (slot.coolingUntil <= Date.now()) {
        slot.coolingUntil = 0;
      }
    }
  }

  reportError(provider: string, key: string, _err: unknown): void {
    const p = this.normalizeProvider(provider);
    const slots = this.pools.get(p) ?? [];
    const slot = slots.find((s) => s.key === key);
    if (slot) {
      slot.activeRequests = Math.max(0, slot.activeRequests - 1);
      slot.errorCount++;
    }
  }
}
