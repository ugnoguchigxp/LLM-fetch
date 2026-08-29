import { LlmFetchError } from "../errors.js";
import { isAbortSignal, waitWithSignal } from "./abort-signal.js";

function cancelResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation) void cancellation.catch(() => undefined);
  } catch {
    // A custom body may already be locked or closed.
  }
}

export async function readResponseBytes(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "maxBytes must be a positive integer.",
    );
  }
  if (signal !== undefined && !isAbortSignal(signal)) {
    throw new LlmFetchError("INVALID_INPUT", "signal must be an AbortSignal.");
  }
  signal?.throwIfAborted();
  const rawContentLength = response.headers.get("content-length") ?? "";
  if (rawContentLength && !/^\d+$/.test(rawContentLength)) {
    cancelResponseBody(response);
    throw new LlmFetchError(
      "UPSTREAM_HTTP",
      "Response content-length is invalid.",
    );
  }
  const contentLength = Number(rawContentLength || 0);
  if (!Number.isSafeInteger(contentLength) || contentLength > maxBytes) {
    cancelResponseBody(response);
    throw new LlmFetchError(
      "RESPONSE_TOO_LARGE",
      `Response content-length exceeds ${maxBytes} bytes.`,
    );
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    while (true) {
      const read = reader.read();
      const item = signal ? await waitWithSignal(read, signal) : await read;
      if (item.done) break;
      received += item.value.byteLength;
      if (received > maxBytes) {
        throw new LlmFetchError(
          "RESPONSE_TOO_LARGE",
          `Response body exceeds ${maxBytes} bytes.`,
        );
      }
      chunks.push(item.value);
    }
  } catch (error) {
    try {
      const cancellation = reader.cancel(error);
      void cancellation.catch(() => undefined);
    } catch {
      // The stream may already be errored or canceled.
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A non-standard stream may keep a read pending after cancellation.
    }
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
