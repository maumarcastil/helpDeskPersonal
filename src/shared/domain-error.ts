/**
 * Every rejection code a domain function or application use case can
 * return. Kept exhaustive here so a switch/lookup over this union can be
 * checked for completeness at compile time (used by the MCP error mapper
 * in a later phase).
 */
export type DomainErrorCode =
  | "VALIDATION_ERROR"
  | "TICKET_NOT_FOUND"
  | "INVALID_TRANSITION"
  | "ACTOR_NOT_PERMITTED"
  | "REOPEN_WINDOW_EXPIRED"
  | "RESOLUTION_CONDITIONS_NOT_MET"
  | "NOT_ALLOWLISTED"
  | "DIAGNOSTIC_NOT_FOUND"
  | "DIAGNOSTIC_NOT_USABLE"
  | "UNKNOWN_SERVICE"
  | "CONFLICT";

export interface DomainError {
  readonly code: DomainErrorCode;
  /** Redacted, plain-language message safe to return to a caller. */
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export function domainError(
  code: DomainErrorCode,
  message: string,
  details?: Record<string, unknown>,
): DomainError {
  return details === undefined ? { code, message } : { code, message, details };
}
