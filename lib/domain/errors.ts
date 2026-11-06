export const ERROR_CODES = [
  "NOT_AUTHORIZED",
  "INVALID_STATE",
  "RATE_LIMITED",
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT_OF_INTEREST",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * A domain rule violation. `message` is written for the calling agent and should say what to
 * do next; `details` carries machine-readable extras (e.g. retry_after_seconds).
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string) =>
  new DomainError("NOT_FOUND", `${what} was not found or is not visible to you.`);

export const notAuthorized = (message: string) => new DomainError("NOT_AUTHORIZED", message);

export const invalidState = (message: string, details: Record<string, unknown> = {}) =>
  new DomainError("INVALID_STATE", message, details);

export const validationError = (message: string, details: Record<string, unknown> = {}) =>
  new DomainError("VALIDATION_ERROR", message, details);
