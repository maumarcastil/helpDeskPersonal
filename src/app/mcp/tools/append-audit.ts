import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TicketId } from "../../../shared/domain/ids.js";
import type { UseCases } from "../../composition-root.js";
import { ActorSchema } from "../schemas.js";
import { redactResponse } from "../ticket-view.js";
import { runResultTool } from "../tool-result.js";

/** `append_audit` (design "MCP tools" table). Only ever appends - there is
 *  no update/delete tool, matching `AuditLog`'s own append-only surface. */
export function registerAppendAuditTool(server: McpServer, useCases: UseCases): void {
  server.registerTool(
    "append_audit",
    {
      description:
        "Append a note or agent decision to a ticket's audit trail. This only ever adds a " +
        "new entry; it can never modify or remove a prior one.",
      inputSchema: {
        ticketId: z.string().min(1),
        actor: ActorSchema,
        kind: z.enum(["note", "agent_decision"]),
        message: z.string().min(1).max(1000),
      },
    },
    async (args) =>
      runResultTool(
        () =>
          useCases.appendAuditNote({
            ticketId: args.ticketId as TicketId,
            actor: args.actor,
            kind: args.kind,
            message: args.message,
          }),
        (output) => redactResponse({ auditRef: output.auditRef }),
      ),
  );
}
