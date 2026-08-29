import { LlmFetchError } from "../errors.js";

export interface Deadline {
  remainingMs(): number;
  signal(external?: AbortSignal): AbortSignal;
}

export function createDeadline(timeoutMs: number): Deadline {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new LlmFetchError("INVALID_INPUT", "timeoutMs must be greater than zero.");
  }
  const monotonicDeadline = performance.now() + timeoutMs;

  return {
    remainingMs() {
      return Math.max(0, monotonicDeadline - performance.now());
    },
    signal(external?: AbortSignal) {
      const remaining = Math.max(1, Math.ceil(monotonicDeadline - performance.now()));
      const timeoutSignal = AbortSignal.timeout(remaining);
      return external
        ? AbortSignal.any([external, timeoutSignal])
        : timeoutSignal;
    },
  };
}

export function throwIfDeadlineElapsed(deadline: Deadline): void {
  if (deadline.remainingMs() <= 0) {
    throw new LlmFetchError("TIMEOUT", "The operation exceeded its deadline.", {
      retryable: true,
    });
  }
}
