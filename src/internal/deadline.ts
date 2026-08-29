import { LlmFetchError } from "../errors.js";

export interface Deadline {
  remainingMs(): number;
  signal(external?: AbortSignal): AbortSignal;
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    );
  }, timeoutMs);
  timer.unref();
  return controller.signal;
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
      const deadlineSignal = timeoutSignal(remaining);
      return external
        ? AbortSignal.any([external, deadlineSignal])
        : deadlineSignal;
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
