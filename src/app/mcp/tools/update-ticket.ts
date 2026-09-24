import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TicketId } from "../../../shared/domain/ids.js";
import type { UseCases } from "../../composition-root.js";
import { ActorSchema, TicketStateSchema } from "../schemas.js";
import { redactResponse, toTicketView } from "../ticket-view.js";
import { runResultTool } from "../tool-result.js";

/**
 * `update_ticket` (design "MCP tools" table). The tool boundary only
 * validates the outer envelope (`ticketId`, `actor`, and that `transition.to`
 * names a real ticket state) via `z.object({...}).passthrough()`; every
 * per-transition payload field (e.g. `Triaged` rejecting a client-supplied
 * `priority`, override #2) is validated by `applyTransition`'s own
 * `.strict()` schemas (task 1.6) - duplicating that validation here would
 * only create a second place for the two to drift apart. The observable
 * behavior at this MCP boundary is identical either way: an invalid
 * payload is still rejected before any transition is applied.
 */
export function registerUpdateTicketTool(server: McpServer, useCases: UseCases): void {
  server.registerTool(
    "update_ticket",
    {
      description:
        "Apply a state transition to a ticket (e.g. New -> Triaged, Triaged -> InProgress). " +
        "The transition object's shape depends on its 'to' target state; an invalid " +
        "transition, wrong actor, or invalid payload is rejected without changing the ticket.",
      inputSchema: {
        ticketId: z.string().min(1),
        actor: ActorSchema,
        transition: z.object({ to: TicketStateSchema }).passthrough(),
      },
    },
    async (args) => {
      const { to, ...payload } = args.transition;
      return runResultTool(
        () =>
          useCases.transitionTicket({
            ticketId: args.ticketId as TicketId,
            actor: args.actor,
            to,
            payload,
          }),
        (output) => redactResponse({ ticket: toTicketView(output.ticket), auditRef: output.auditRef }),
      );
    },
  );
}
