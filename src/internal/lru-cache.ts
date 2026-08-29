interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class LruCache<T> {
  readonly #maxEntries: number;
  readonly #items = new Map<string, CacheEntry<T>>();

  constructor(maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 0) {
      throw new RangeError("maxEntries must be a non-negative integer.");
    }
    this.#maxEntries = maxEntries;
  }

  get(key: string): T | undefined {
    const entry = this.#items.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= performance.now()) {
      this.#items.delete(key);
      return undefined;
    }
    this.#items.delete(key);
    this.#items.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    if (this.#maxEntries === 0 || ttlMs <= 0) return;
    this.#items.delete(key);
    this.#items.set(key, { value, expiresAt: performance.now() + ttlMs });
    while (this.#items.size > this.#maxEntries) {
      const oldest = this.#items.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.#items.delete(oldest);
    }
  }

  clear(): void {
    this.#items.clear();
  }
}
