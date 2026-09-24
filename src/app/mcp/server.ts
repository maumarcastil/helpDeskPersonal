import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BuiltApp } from "../composition-root.js";
import { registerCreateTicketTool } from "./tools/create-ticket.js";
import { registerGetTicketTool } from "./tools/get-ticket.js";
import { registerListTicketsTool } from "./tools/list-tickets.js";
import { registerUpdateTicketTool } from "./tools/update-ticket.js";
import { registerAppendAuditTool } from "./tools/append-audit.js";
import { registerRunDiagnosticTool } from "./tools/run-diagnostic.js";
import { registerApplyRemediationTool } from "./tools/apply-remediation.js";

const SERVER_NAME = "helpdesk";
const SERVER_VERSION = "0.1.0";

/**
 * Registers exactly the `TOOL_NAMES` tools (design "MCP tools"; task 4.10
 * asserts the advertised list is exactly this set, no more, no fewer) on a
 * fresh `McpServer` bound to `app.useCases`. Grown one tool at a time as
 * each handler lands in this phase.
 */
export function createServer(app: BuiltApp): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerCreateTicketTool(server, app.useCases);
  registerGetTicketTool(server, app.useCases);
  registerListTicketsTool(server, app.useCases);
  registerUpdateTicketTool(server, app.useCases);
  registerAppendAuditTool(server, app.useCases);
  registerRunDiagnosticTool(server, app.useCases);
  registerApplyRemediationTool(server, app.useCases);
  return server;
}
