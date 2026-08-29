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
});
