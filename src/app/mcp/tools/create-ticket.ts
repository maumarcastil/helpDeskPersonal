import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TicketId } from "../../../shared/domain/ids.js";
import type { UseCases } from "../../composition-root.js";
import { redactResponse, toTicketView } from "../ticket-view.js";
import { runResultTool } from "../tool-result.js";

/**
 * `create_ticket` (design "MCP tools" table). Call this first for a new
 * issue: free text is redacted before it is ever persisted (spec
 * `sensitive-data-redaction`), and the ticket starts in `New` awaiting
 * triage via `update_ticket`.
 */
export function registerCreateTicketTool(server: McpServer, useCases: UseCases): void {
  server.registerTool(
    "create_ticket",
    {
      description:
        "Create a new help desk ticket from free-text describing the issue. Call this " +
        "first for any new issue. The text is redacted before it is stored. Returns the " +
        "new ticket in the 'New' state; call update_ticket next to triage it.",
      inputSchema: {
        text: z.string().min(1).max(4000),
        relatedTicketId: z.string().min(1).optional(),
      },
    },
    async (args) =>
      runResultTool(
        () =>
          useCases.createTicket({
            text: args.text,
            ...(args.relatedTicketId !== undefined
              ? { relatedTicketId: args.relatedTicketId as TicketId }
              : {}),
          }),
        (output) => redactResponse({ ticket: toTicketView(output.ticket) }),
      ),
  );
}
