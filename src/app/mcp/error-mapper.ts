import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DomainError, DomainErrorCode } from "../../shared/domain/domain-error.js";

export type ClientErrorCode = DomainErrorCode | "INTERNAL_ERROR";

export interface ToolErrorEnvelope {
  readonly error: {
    readonly code: ClientErrorCode;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  };
}

/**
 * Compile-time exhaustiveness check over every `DomainErrorCode` (task
 * 4.3's acceptance: "a switch/lookup with no default fallthrough"). Adding a
 * new `DomainErrorCode` member without updating this switch fails to
 * compile, because the unreachable `default` branch can only accept `never`.
 */
function assertKnownDomainErrorCode(code: DomainErrorCode): void {
  switch (code) {
    case "VALIDATION_ERROR":
    case "TICKET_NOT_FOUND":
    case "INVALID_TRANSITION":
    case "ACTOR_NOT_PERMITTED":
    case "REOPEN_WINDOW_EXPIRED":
    case "RESOLUTION_CONDITIONS_NOT_MET":
    case "NOT_ALLOWLISTED":
    case "DIAGNOSTIC_NOT_FOUND":
    case "DIAGNOSTIC_NOT_USABLE":
    case "UNKNOWN_SERVICE":
    case "CONFLICT":
      return;
    default: {
      const exhaustive: never = code;
      throw new Error(`unmapped DomainErrorCode: ${String(exhaustive)}`);
    }
  }
}

function buildResult(envelope: ToolErrorEnvelope): CallToolResult {
  return {
    isError: true,
    structuredContent: { ...envelope },
    content: [{ type: "text", text: JSON.stringify(envelope) }],
  };
}

/**
 * Maps a `DomainError` returned by a use case to the MCP error contract
 * (design "MCP tools" -> "Error contract"). `DomainError` already carries a
 * redacted, client-safe `message`/`details` (every use case constructs it
 * that way) - this function's job is the exhaustive code check plus
 * shaping the envelope, not re-validating the message content.
 */
export function mapDomainError(error: DomainError): CallToolResult {
  assertKnownDomainErrorCode(error.code);
  return buildResult({
    error:
      error.details === undefined
        ? { code: error.code, message: error.message }
        : { code: error.code, message: error.message, details: error.details },
  });
}

/**
 * Maps an unexpected thrown value (a bug, not a modeled `DomainError`) to
 * `INTERNAL_ERROR`. The client-facing message never contains a stack trace
 * or the raw error message (which could itself contain unredacted input
 * that reached this deep only because something else already went wrong);
 * the full detail goes to stderr only - stdout is the MCP protocol stream
 * and must stay clean of anything but protocol frames.
 */
export function mapUnexpectedError(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  process.stderr.write(`[helpdesk] INTERNAL_ERROR: ${message}\n${stack ?? ""}\n`);

  return buildResult({
    error: { code: "INTERNAL_ERROR", message: "internal server error" },
  });
}
