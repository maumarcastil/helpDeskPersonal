import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DomainError } from "../../shared/domain/domain-error.js";
import type { Result } from "../../shared/kernel/result.js";
import { mapDomainError, mapUnexpectedError } from "./error-mapper.js";

export function toolSuccess(structuredContent: Record<string, unknown>): CallToolResult {
  return { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] };
}

/**
 * Runs a use case that returns a `Result`, mapping the ok/err/unexpected-
 * throw cases uniformly to the MCP tool contract (design "MCP tools" ->
 * "Error contract"). Every handler that wraps a `Result`-returning use case
 * funnels through this so none of them hand-builds the response envelope.
 */
export async function runResultTool<T>(
  run: () => Promise<Result<T, DomainError>>,
  shape: (value: T) => Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    const result = await run();
    if (!result.ok) return mapDomainError(result.error);
    return toolSuccess(shape(result.value));
  } catch (error) {
    return mapUnexpectedError(error);
  }
}

/** Same as `runResultTool`, for the one use case (`ListTickets`) that has no
 *  error path and returns its output directly rather than wrapped in a
 *  `Result` - there is nothing to reject a ticket listing for. */
export async function runPlainTool<T>(
  run: () => Promise<T>,
  shape: (value: T) => Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    const value = await run();
    return toolSuccess(shape(value));
  } catch (error) {
    return mapUnexpectedError(error);
  }
}
