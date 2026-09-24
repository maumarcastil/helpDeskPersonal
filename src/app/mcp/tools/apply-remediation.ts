import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RunId, TicketId } from "../../../shared/domain/ids.js";
import type { UseCases } from "../../composition-root.js";
import { ActorSchema } from "../schemas.js";
import { redactResponse, toTicketView } from "../ticket-view.js";
import { runResultTool } from "../tool-result.js";

/**
 * `apply_remediation` (design "MCP tools" table; ADR 0010 - dedicated tool
 * with a typed allowlist, override #1). A run without a `remediate`
 * decision returns `NOT_ALLOWLISTED`; a stale/missing run returns
 * `DIAGNOSTIC_NOT_USABLE` - both already enforced by `ApplyRemediation`
 * (task 2.16). Rejecting an `actor: 'triage'` call is likewise already
 * enforced inside the use case.
 */
export function registerApplyRemediationTool(server: McpServer, useCases: UseCases): void {
  server.registerTool(
    "apply_remediation",
    {
      description:
        "Apply the allowlisted remediation a prior run_diagnostic call decided on. Only " +
        "the 'diagnostic' actor may call this. Moves the ticket to " +
        "PendingUserConfirmation and records what was done.",
      inputSchema: {
        ticketId: z.string().min(1),
        actor: ActorSchema,
        runId: z.string().min(1),
      },
    },
    async (args) =>
      runResultTool(
        () =>
          useCases.applyRemediation({
            ticketId: args.ticketId as TicketId,
            actor: args.actor,
            runId: args.runId as RunId,
          }),
        (output) =>
          redactResponse({
            ticket: toTicketView(output.ticket),
            action: output.action,
            userMessage: output.userMessage,
            auditRef: output.auditRef,
          }),
      ),
  );
}
