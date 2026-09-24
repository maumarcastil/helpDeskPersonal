import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { UseCases } from "../../composition-root.js";
import { CategorySchema, PrioritySchema, TicketStateSchema } from "../schemas.js";
import { redactResponse, toTicketSummary } from "../ticket-view.js";
import { runPlainTool } from "../tool-result.js";

/**
 * `list_tickets` (design "MCP tools" table). `ListTickets` (task 2.14)
 * already clamps `limit` to 50 server-side regardless of what is
 * requested; this tool just forwards the filters.
 */
export function registerListTicketsTool(server: McpServer, useCases: UseCases): void {
  server.registerTool(
    "list_tickets",
    {
      description: "List tickets, optionally filtered by state, category, or priority (max 50).",
      inputSchema: {
        state: TicketStateSchema.optional(),
        category: CategorySchema.optional(),
        priority: PrioritySchema.optional(),
        // No upper bound here: ListTickets itself clamps to 50 regardless
        // of what is requested (task 2.14) - rejecting a too-large limit at
        // this layer would contradict that "clamp, don't reject" contract.
        limit: z.number().int().min(1).optional(),
      },
    },
    async (args) =>
      runPlainTool(
        () =>
          useCases.listTickets({
            ...(args.state !== undefined ? { state: args.state } : {}),
            ...(args.category !== undefined ? { category: args.category } : {}),
            ...(args.priority !== undefined ? { priority: args.priority } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
          }),
        (output) => redactResponse({ tickets: output.tickets.map(toTicketSummary) }),
      ),
  );
}
