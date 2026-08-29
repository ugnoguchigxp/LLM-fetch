import { waitWithSignal } from "./abort-signal.js";

interface InFlightEntry<T> {
  controller: AbortController;
  promise: Promise<T>;
  settled: boolean;
  waiters: number;
}

export class InFlightMap<T> {
  readonly #items = new Map<string, InFlightEntry<T>>();

  run(
    key: string,
    task: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    let entry = this.#items.get(key);
    if (!entry) {
      const controller = new AbortController();
      const createdEntry: InFlightEntry<T> = {
        controller,
        promise: Promise.resolve()
          .then(() => task(controller.signal))
          .finally(() => {
            createdEntry.settled = true;
            if (this.#items.get(key) === createdEntry) this.#items.delete(key);
          }),
        settled: false,
        waiters: 0,
      };
      entry = createdEntry;
      this.#items.set(key, createdEntry);
    }

    entry.waiters += 1;
    const completion = callerSignal
      ? waitWithSignal(entry.promise, callerSignal)
      : entry.promise;
    return completion.finally(() => {
      entry.waiters -= 1;
      if (entry.waiters === 0 && !entry.settled) {
        if (this.#items.get(key) === entry) this.#items.delete(key);
        entry.controller.abort();
      }
    });
  }

  clear(): void {
    for (const entry of this.#items.values()) entry.controller.abort();
    this.#items.clear();
  }
}
