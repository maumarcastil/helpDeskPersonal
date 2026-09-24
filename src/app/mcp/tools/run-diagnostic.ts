import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RunDiagnosticOutput } from "../../../diagnostics/application/run-diagnostic.js";
import type { TicketId } from "../../../shared/domain/ids.js";
import type { UseCases } from "../../composition-root.js";
import { ActorSchema } from "../schemas.js";
import { redactResponse } from "../ticket-view.js";
import { runResultTool } from "../tool-result.js";

/**
 * A short, presentation-only summary of a diagnostic outcome. Not a domain
 * concept (`RunDiagnosticOutput` carries no such field) - this is purely
 * how the MCP tool layer explains the result to whichever agent called it.
 */
function buildUserMessage(output: RunDiagnosticOutput): string {
  if (output.outcome === "failed") {
    return "The diagnostic could not complete; this has been escalated.";
  }
  if (output.decision.kind === "remediate") {
    return "A known fix is available for this issue. Call apply_remediation to apply it.";
  }
  return "No automatic fix is available for this issue; it has been escalated.";
}

/**
 * `run_diagnostic` (design "MCP tools" table). Delegates entirely to
 * `RunDiagnostic` (task 2.15/3.6), which either returns a diagnostic
 * result or a runner-failure indication - never a mix of both in the same
 * response, since the use case's own output type keeps `outcome`/
 * `failureReason` mutually consistent. Rejecting an `actor: 'triage'` call
 * is already enforced inside the use case (`ACTOR_NOT_PERMITTED`); this
 * tool adds no separate check, since duplicating it here would just be a
 * second place for the two to drift apart.
 */
export function registerRunDiagnosticTool(server: McpServer, useCases: UseCases): void {
  server.registerTool(
    "run_diagnostic",
    {
      description:
        "Run a connectivity diagnostic against the ticket's impacted service. Only the " +
        "'diagnostic' actor may call this. Returns either a completed result with a " +
        "remediation decision, or a runner-failure indication - never both.",
      inputSchema: {
        ticketId: z.string().min(1),
        actor: ActorSchema,
        probe: z.literal("connectivity"),
      },
    },
    async (args) =>
      runResultTool(
        () => useCases.runDiagnostic({ ticketId: args.ticketId as TicketId, actor: args.actor }),
        (output) =>
          redactResponse({
            ...(output.runId !== undefined ? { runId: output.runId } : {}),
            ...(output.outcome !== undefined ? { outcome: output.outcome } : {}),
            ...(output.failureReason !== undefined ? { failureReason: output.failureReason } : {}),
            decision: output.decision,
            userMessage: buildUserMessage(output),
          }),
      ),
  );
}
