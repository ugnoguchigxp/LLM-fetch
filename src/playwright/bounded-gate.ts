import { LlmFetchError } from "../errors.js";
import { abortReason } from "../internal/abort-signal.js";

interface Waiter {
  resolve(): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class BoundedGate {
  readonly #limit: number;
  readonly #maxQueue: number;
  #active = 0;
  readonly #queue: Waiter[] = [];

  constructor(limit: number, maxQueue: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("BoundedGate limit must be a positive integer.");
    }
    if (!Number.isInteger(maxQueue) || maxQueue < 0) {
      throw new RangeError("BoundedGate maxQueue must be a non-negative integer.");
    }
    this.#limit = limit;
    this.#maxQueue = maxQueue;
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.#acquire(signal);
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  async #acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.#active < this.#limit) {
      this.#active += 1;
      return;
    }
    if (this.#queue.length >= this.#maxQueue) {
      throw new LlmFetchError("RATE_LIMITED", "The browser retrieval queue is full.", {
        retryable: true,
      });
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (signal) {
        waiter.signal = signal;
        waiter.onAbort = () => {
          const index = this.#queue.indexOf(waiter);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#queue.push(waiter);
    });
  }

  #release(): void {
    const waiter = this.#queue.shift();
    if (waiter) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      // Keep the slot occupied while handing it to the waiter. Releasing it
      // first would allow a new caller to overtake the queued operation.
      waiter.resolve();
      return;
    }
    this.#active -= 1;
  }
}
