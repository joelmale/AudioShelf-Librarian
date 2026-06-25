/**
 * Structured error model for the whole project.
 *
 * MADP constraint (D3): error reporting uses the structured payload shape
 * `{ error, code, detail? }` — never a bare `console.log(err)`. Every layer
 * (core, api, mcp) maps failures onto an {@link AppError} subclass so the
 * surface returned to the user/Claude is typed and actionable.
 */

/** The canonical structured error payload returned across every boundary. */
export interface StructuredError {
  error: string;
  code: ErrorCode;
  detail?: unknown;
}

/** Stable machine-readable error codes. */
export type ErrorCode =
  | 'ABS_AUTH' // 401/403 from ABS — token invalid/expired
  | 'ABS_CONNECTION' // network unreachable / timeout
  | 'ABS_REQUEST' // other non-2xx from ABS
  | 'ABS_NOT_FOUND' // 404 from ABS
  | 'ABS_CONFLICT' // name conflict / 409 from ABS
  | 'ANTHROPIC_RATE_LIMIT' // 429 after retries exhausted
  | 'ANTHROPIC_QUOTA' // billing/quota exhausted
  | 'ANTHROPIC_INVALID_RESPONSE' // malformed / non-JSON model output
  | 'ANTHROPIC_REQUEST' // other Anthropic API failure
  | 'VALIDATION' // Zod / input validation failure
  | 'NOT_FOUND' // local resource not found
  | 'CONFLICT' // local state conflict (e.g. wrong status)
  | 'CANCELLED' // operation cancelled by the user
  | 'DB' // SQLite failure
  | 'ENCODE' // audio encode subprocess failed
  | 'ENCODE_TOOL_MISSING' // m4b-tool / ffmpeg binary not found
  | 'PATH_FORBIDDEN' // filesystem path escapes the configured library root
  | 'INTERNAL'; // uncategorized

/** HTTP status used when an AppError is surfaced over the REST API. */
const DEFAULT_HTTP_STATUS: Record<ErrorCode, number> = {
  ABS_AUTH: 502,
  ABS_CONNECTION: 504,
  ABS_REQUEST: 502,
  ABS_NOT_FOUND: 404,
  ABS_CONFLICT: 409,
  ANTHROPIC_RATE_LIMIT: 503,
  ANTHROPIC_QUOTA: 503,
  ANTHROPIC_INVALID_RESPONSE: 502,
  ANTHROPIC_REQUEST: 502,
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CANCELLED: 409,
  DB: 500,
  ENCODE: 500,
  ENCODE_TOOL_MISSING: 503,
  PATH_FORBIDDEN: 400,
  INTERNAL: 500,
};

/** Base class for every error intentionally surfaced by the application. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly detail?: unknown;
  readonly httpStatus: number;
  /** The error that caused this one, if any (for logging, never serialized raw). */
  override readonly cause?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    options: { detail?: unknown; httpStatus?: number; cause?: unknown } = {}
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.detail = options.detail;
    this.httpStatus = options.httpStatus ?? DEFAULT_HTTP_STATUS[code];
    this.cause = options.cause;
    // Maintain prototype chain when targeting ES2022 down-level.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Serialize to the wire-safe structured payload (never leaks the cause). */
  toPayload(): StructuredError {
    const payload: StructuredError = { error: this.message, code: this.code };
    if (this.detail !== undefined) payload.detail = this.detail;
    return payload;
  }
}

/** ABS returned 401/403 — the token is invalid or expired. Do NOT retry blindly. */
export class ABSAuthError extends AppError {
  constructor(message = 'ABS token invalid or expired', detail?: unknown) {
    super('ABS_AUTH', message, { detail });
  }
}

/** ABS unreachable: DNS/connection refused/timeout. */
export class ABSConnectionError extends AppError {
  constructor(message: string, cause?: unknown) {
    super('ABS_CONNECTION', message, { cause });
  }
}

/** ABS returned a non-2xx we don't have a more specific class for. */
export class ABSRequestError extends AppError {
  readonly status: number;
  constructor(status: number, message: string, detail?: unknown) {
    const code: ErrorCode =
      status === 404 ? 'ABS_NOT_FOUND' : status === 409 ? 'ABS_CONFLICT' : 'ABS_REQUEST';
    super(code, message, { detail, httpStatus: code === 'ABS_NOT_FOUND' ? 404 : 502 });
    this.status = status;
  }
}

/** Anthropic 429 rate limit (after the bounded retry budget is spent). */
export class AnthropicRateLimitError extends AppError {
  readonly retryAfterMs?: number;
  constructor(message = 'Anthropic rate limit exceeded', retryAfterMs?: number) {
    super('ANTHROPIC_RATE_LIMIT', message, {
      detail: retryAfterMs !== undefined ? { retryAfterMs } : undefined,
    });
    this.retryAfterMs = retryAfterMs;
  }
}

/** Anthropic billing/quota exhausted — actionable, not a generic 500. */
export class AnthropicQuotaError extends AppError {
  constructor(message = 'Anthropic quota or credit exhausted', detail?: unknown) {
    super('ANTHROPIC_QUOTA', message, { detail });
  }
}

/** Model returned content that failed JSON parse or Zod validation. */
export class AnthropicInvalidResponseError extends AppError {
  constructor(message = 'Claude returned an unparseable response', detail?: unknown) {
    super('ANTHROPIC_INVALID_RESPONSE', message, { detail });
  }
}

/** Generic Anthropic API failure not covered above. */
export class AnthropicRequestError extends AppError {
  constructor(message: string, detail?: unknown) {
    super('ANTHROPIC_REQUEST', message, { detail });
  }
}

/** Input / response shape validation failure. */
export class ValidationError extends AppError {
  constructor(message: string, detail?: unknown) {
    super('VALIDATION', message, { detail });
  }
}

/** A locally-referenced resource does not exist. */
export class NotFoundError extends AppError {
  constructor(message: string, detail?: unknown) {
    super('NOT_FOUND', message, { detail });
  }
}

/** Local state conflict (e.g. pushing a non-approved collection). */
export class ConflictError extends AppError {
  constructor(message: string, detail?: unknown) {
    super('CONFLICT', message, { detail });
  }
}

/** Raised inside a long-running operation when the user cancels it. */
export class OperationCancelledError extends AppError {
  constructor(operationId: string) {
    super('CANCELLED', `Operation ${operationId} was cancelled`, { detail: { operationId } });
  }
}

/** SQLite-level failure. */
export class DBError extends AppError {
  constructor(message: string, cause?: unknown) {
    super('DB', message, { cause });
  }
}

/** An audio encode (m4b-tool/ffmpeg) subprocess failed or produced bad output. */
export class EncodeError extends AppError {
  constructor(message: string, detail?: unknown, cause?: unknown) {
    super('ENCODE', message, { detail, cause });
  }
}

/** The m4b-tool or ffmpeg binary could not be found/spawned. */
export class EncodeToolMissingError extends AppError {
  constructor(message = 'm4b-tool / ffmpeg binary not found', detail?: unknown) {
    super('ENCODE_TOOL_MISSING', message, { detail });
  }
}

/** A requested filesystem path escapes the configured library root. */
export class PathForbiddenError extends AppError {
  constructor(message: string, detail?: unknown) {
    super('PATH_FORBIDDEN', message, { detail });
  }
}

/**
 * Coerce any thrown value into an {@link AppError} so callers always have a
 * structured payload. Unknown errors become INTERNAL with the original message
 * preserved (and the raw cause attached for logging only).
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error) {
    return new AppError('INTERNAL', err.message, { cause: err });
  }
  return new AppError('INTERNAL', 'Unknown error', { cause: err, detail: String(err) });
}

/** Convenience: turn any thrown value into the wire payload in one step. */
export function toErrorPayload(err: unknown): StructuredError {
  return toAppError(err).toPayload();
}
