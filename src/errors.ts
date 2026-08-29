export type LlmFetchErrorCode =
  | "INVALID_INPUT"
  | "CONFIG_MISSING"
  | "UNSAFE_URL"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "BOT_CHALLENGE"
  | "UPSTREAM_HTTP"
  | "PARSE_CHANGED"
  | "RESPONSE_TOO_LARGE"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "UNSUPPORTED_CONTENT_ENCODING"
  | "CONTENT_INSUFFICIENT"
  | "GUARD_FAILED"
  | "GUARD_DENIED"
  | "UNKNOWN";

export interface LlmFetchErrorOptions extends ErrorOptions {
  provider?: string;
  url?: string;
  status?: number;
  retryable?: boolean;
  cooldownMs?: number;
}

export class LlmFetchError extends Error {
  readonly code: LlmFetchErrorCode;
  readonly provider?: string;
  readonly url?: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly cooldownMs?: number;

  constructor(
    code: LlmFetchErrorCode,
    message: string,
    options: LlmFetchErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "LlmFetchError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.url !== undefined) this.url = options.url;
    if (options.status !== undefined) this.status = options.status;
    if (options.cooldownMs !== undefined) this.cooldownMs = options.cooldownMs;
  }
}

export function toLlmFetchError(
  error: unknown,
  fallback: {
    code?: LlmFetchErrorCode;
    message: string;
    provider?: string;
    url?: string;
    retryable?: boolean;
  },
): LlmFetchError {
  if (error instanceof LlmFetchError) return error;
  const options: LlmFetchErrorOptions = {
    cause: error,
    retryable: fallback.retryable ?? false,
  };
  if (fallback.provider !== undefined) options.provider = fallback.provider;
  if (fallback.url !== undefined) options.url = fallback.url;
  return new LlmFetchError(
    fallback.code ?? "UNKNOWN",
    fallback.message,
    options,
  );
}
