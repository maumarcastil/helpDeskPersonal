/**
 * The exact, exhaustive set of MCP tools this server advertises (design
 * "MCP tools", override #1: 7 tools including `apply_remediation`). Reused
 * unmodified by `server.ts` (task 4.10) and by the Phase 6 generator, so a
 * new tool can only ever be added in one place.
 */
export const TOOL_NAMES = [
  "create_ticket",
  "get_ticket",
  "list_tickets",
  "update_ticket",
  "append_audit",
  "run_diagnostic",
  "apply_remediation",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
