export class Semaphore {
  readonly #limit: number;
  #active = 0;
  readonly #queue: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("Semaphore limit must be a positive integer.");
    }
    this.#limit = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.#limit) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.#queue.push(resolve));
  }

  #release(): void {
    const waiter = this.#queue.shift();
    if (waiter) {
      // Transfer the occupied slot directly. Decrementing first would let a
      // newly arriving task race the resumed waiter and exceed the limit.
      waiter();
      return;
    }
    this.#active -= 1;
  }
}
