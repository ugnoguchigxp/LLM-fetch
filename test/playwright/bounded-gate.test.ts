import { describe, expect, it, vi } from "vitest";
import { BoundedGate } from "../../src/playwright/bounded-gate.js";

describe("Playwright bounded gate", () => {
  it("validates concurrency bounds", () => {
    expect(() => new BoundedGate(0, 1)).toThrow(RangeError);
    expect(() => new BoundedGate(1, -1)).toThrow(RangeError);
  });

  it("bounds both active work and the waiting queue", async () => {
    const gate = new BoundedGate(1, 1);
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const first = gate.run(async () => {
      markFirstStarted();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return "first";
    });
    await firstStarted;

    const secondTask = vi.fn(async () => "second");
    const second = gate.run(secondTask);
    await expect(gate.run(async () => "third")).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });

    releaseFirst();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(secondTask).toHaveBeenCalledOnce();
  });

  it("removes an aborted waiter without consuming capacity", async () => {
    const gate = new BoundedGate(1, 1);
    let releaseActive!: () => void;
    const active = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const first = gate.run(async () => active);
    await Promise.resolve();

    const controller = new AbortController();
    const waiting = gate.run(async () => undefined, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });

    releaseActive();
    await first;
    await expect(gate.run(async () => "available")).resolves.toBe("available");
  });

  it("transfers capacity to queued work without allowing an arriving task to overtake", async () => {
    const gate = new BoundedGate(1, 2);
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
    const first = gate.run(async () => enter(firstWait));
    await Promise.resolve();
    const queued = gate.run(async () => enter());

    releaseFirst();
    let arriving!: Promise<void>;
    queueMicrotask(() => {
      arriving = gate.run(async () => enter());
    });

    await first;
    await queued;
    await arriving;
    expect(maximumActive).toBe(1);
  });
});
