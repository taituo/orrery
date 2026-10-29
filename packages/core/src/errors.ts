/**
 * Error taxonomy shared by API, workers and workflows. `retryable` drives Temporal retry
 * policies (non-retryable errors are raised as ApplicationFailure.nonRetryable) and the
 * HTTP status the API returns.
 */
export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "provider_unavailable"
  | "provider_error"
  | "protocol_error"
  | "capability_unsupported"
  | "timeout"
  | "cancelled"
  | "interrupted"
  | "policy_denied"
  | "internal";

const HTTP_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  provider_unavailable: 503,
  provider_error: 502,
  protocol_error: 502,
  capability_unsupported: 501,
  timeout: 504,
  cancelled: 499,
  interrupted: 503,
  policy_denied: 403,
  internal: 500,
};

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "rate_limited",
  "provider_unavailable",
  "timeout",
  "interrupted",
]);

export class OrreryError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, options: { cause?: unknown; details?: Record<string, unknown>; retryable?: boolean } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OrreryError";
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.details = options.details;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }

  toJSON(): { code: ErrorCode; message: string; retryable: boolean; details?: Record<string, unknown> } {
    return { code: this.code, message: this.message, retryable: this.retryable, ...(this.details ? { details: this.details } : {}) };
  }
}

export function isOrreryError(err: unknown): err is OrreryError {
  return err instanceof OrreryError || (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "OrreryError");
}

export function toOrreryError(err: unknown, fallback: ErrorCode = "internal"): OrreryError {
  if (isOrreryError(err)) return err as OrreryError;
  if (err instanceof Error) {
    if (err.name === "AbortError") return new OrreryError("cancelled", err.message, { cause: err });
    return new OrreryError(fallback, err.message, { cause: err });
  }
  return new OrreryError(fallback, String(err));
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
