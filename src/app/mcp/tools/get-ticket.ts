import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TicketId } from "../../../shared/domain/ids.js";
import type { UseCases } from "../../composition-root.js";
import { allowedTransitionsFor, redactResponse, toTicketView } from "../ticket-view.js";
import { runResultTool } from "../tool-result.js";

/**
 * `get_ticket` (design "MCP tools" table). Returns the ticket plus
 * `allowedTransitions` for its current state, computed from the same
 * transition table `update_ticket` enforces, so a client always knows
 * exactly what it can call next without guessing.
 */
export function registerGetTicketTool(server: McpServer, useCases: UseCases): void {
  server.registerTool(
    "get_ticket",
    {
      description:
        "Fetch a ticket by id, including which transitions are currently allowed and by " +
        "which actors. Every field is redacted before it is returned.",
      inputSchema: {
        ticketId: z.string().min(1),
      },
    },
    async (args) =>
      runResultTool(
        () => useCases.getTicket({ ticketId: args.ticketId as TicketId }),
        (output) =>
          redactResponse({
            ticket: toTicketView(output.ticket),
            allowedTransitions: allowedTransitionsFor(output.ticket.state),
          }),
      ),
  );
}
