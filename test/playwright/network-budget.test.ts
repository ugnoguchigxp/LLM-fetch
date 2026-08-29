import type { CDPSession } from "playwright-core";
import { describe, expect, it } from "vitest";
import type { LlmFetchError } from "../../src/errors.js";
import { monitorNetworkBudget } from "../../src/playwright/retriever.js";

function fakeSession(): {
  session: CDPSession;
  emit(event: string, payload: unknown): void;
} {
  const listeners = new Map<string, (payload: unknown) => void>();
  const value = {
    on(event: string, listener: (payload: unknown) => void) {
      listeners.set(event, listener);
      return value;
    },
  };
  return {
    session: value as unknown as CDPSession,
    emit(event, payload) {
      listeners.get(event)?.(payload);
    },
  };
}

describe("Playwright network budget", () => {
  it("counts the larger decoded or encoded size without double counting", () => {
    const { session, emit } = fakeSession();
    const failures: LlmFetchError[] = [];
    monitorNetworkBudget(session, 70, (error) => failures.push(error));

    emit("Network.dataReceived", {
      requestId: "one",
      dataLength: 60,
      encodedDataLength: 30,
    });
    emit("Network.loadingFinished", {
      requestId: "one",
      encodedDataLength: 30,
    });
    expect(failures).toEqual([]);

    emit("Network.dataReceived", {
      requestId: "two",
      dataLength: 20,
      encodedDataLength: 10,
    });
    expect(failures).toEqual([
      expect.objectContaining({ code: "RESPONSE_TOO_LARGE" }),
    ]);
  });

  it("fails closed on invalid browser accounting values", () => {
    const { session, emit } = fakeSession();
    const failures: LlmFetchError[] = [];
    monitorNetworkBudget(session, 1_000, (error) => failures.push(error));

    emit("Network.dataReceived", {
      requestId: "invalid",
      dataLength: Number.NaN,
      encodedDataLength: 0,
    });
    expect(failures).toEqual([
      expect.objectContaining({ code: "UPSTREAM_HTTP" }),
    ]);
  });
});
