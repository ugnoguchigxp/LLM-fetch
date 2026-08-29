import { describe, expect, it } from "vitest";
import { waitWithSignal } from "../../src/internal/abort-signal.js";
import { createDeadline } from "../../src/internal/deadline.js";

describe("Deadline", () => {
  it("stays armed after an abort listener is removed", async () => {
    const signal = createDeadline(20).signal();
    const listener = () => undefined;
    signal.addEventListener("abort", listener);
    signal.removeEventListener("abort", listener);

    let watchdogTimer!: ReturnType<typeof setTimeout>;
    const watchdog = new Promise<never>((_resolve, reject) => {
      watchdogTimer = setTimeout(
        () => reject(new Error("deadline watchdog elapsed")),
        250,
      );
    });
    const neverSettles = new Promise<never>(() => undefined);

    try {
      await expect(
        Promise.race([waitWithSignal(neverSettles, signal), watchdog]),
      ).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      clearTimeout(watchdogTimer);
    }
  });
});
