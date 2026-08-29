import { describe, expect, it } from "vitest";
import { Semaphore } from "../../src/internal/semaphore.js";

describe("Semaphore", () => {
  it("transfers capacity to queued work without allowing an arriving task to overtake", async () => {
    const semaphore = new Semaphore(1);
    let releaseFirst!: () => void;
    let active = 0;
    let maximumActive = 0;
    const enter = async (wait?: Promise<void>) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (wait) await wait;
      await Promise.resolve();
      active -= 1;
    };
    const firstWait = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = semaphore.run(async () => enter(firstWait));
    await Promise.resolve();
    const queued = semaphore.run(async () => enter());

    releaseFirst();
    let arriving!: Promise<void>;
    queueMicrotask(() => {
      arriving = semaphore.run(async () => enter());
    });

    await first;
    await queued;
    await arriving;
    expect(maximumActive).toBe(1);
  });
});
