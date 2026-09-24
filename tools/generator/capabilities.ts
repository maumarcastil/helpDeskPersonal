import { TOOL_NAMES, type ToolName } from "../../src/app/mcp/tool-names.js";
import type { Capability } from "./definitions/schema.js";

/**
 * The abstract capability -> concrete MCP tool name map (ADR 0009: "Agents
 * declare capabilities, never platform tool names; tool names come from
 * TOOL_NAMES"). This is the one place a generator capability is translated
 * into a real tool name — renderers apply their own platform prefix
 * (`helpdesk/<tool>`, `mcp__helpdesk__<tool>`, `helpdesk_<tool>`) on top of
 * the bare names returned here (task 6.6+, PR B).
 *
 * `satisfies` (rather than an explicit `Record<Capability, ...>` type
 * annotation) keeps each property's literal tuple type so callers get an
 * exact `readonly ["get_ticket", "list_tickets"]` rather than a widened
 * `readonly ToolName[]`, while still checking every key is a `Capability`
 * and every value only contains real `ToolName`s.
 */
export const CAPABILITY_TOOL_MAP = {
  "ticket.create": ["create_ticket"],
  "ticket.read": ["get_ticket", "list_tickets"],
  "ticket.update": ["update_ticket"],
  "audit.append": ["append_audit"],
  "diagnostic.run": ["run_diagnostic"],
  "remediation.apply": ["apply_remediation"],
} as const satisfies Record<Capability, readonly ToolName[]>;

export function toolsForCapability(capability: Capability): readonly ToolName[] {
  return CAPABILITY_TOOL_MAP[capability];
}

/** The deduplicated union of tools required by a set of capabilities. */
export function toolsForCapabilities(capabilities: readonly Capability[]): readonly ToolName[] {
  const tools = new Set<ToolName>();
  for (const capability of capabilities) {
    for (const tool of toolsForCapability(capability)) {
      tools.add(tool);
    }
  }
  return [...tools];
}

/**
 * Runtime defense-in-depth on top of capabilities.test.ts's coverage
 * assertions: every real MCP tool must be reachable through exactly one
 * capability, so a new tool added to `TOOL_NAMES` without updating this map
 * fails loudly the moment this module is imported (build-time, well before
 * any file is generated) rather than silently producing an agent that is
 * missing a tool it needs.
 */
function assertExactCoverage(): void {
  const allMapped = Object.values(CAPABILITY_TOOL_MAP).flat();
  const uncovered = TOOL_NAMES.filter((tool) => !allMapped.includes(tool));
  if (uncovered.length > 0) {
    throw new Error(
      `tools/generator/capabilities.ts: TOOL_NAMES entries with no capability: ${uncovered.join(", ")}`,
    );
  }
  const unknown = allMapped.filter((tool) => !(TOOL_NAMES as readonly string[]).includes(tool));
  if (unknown.length > 0) {
    throw new Error(
      `tools/generator/capabilities.ts: CAPABILITY_TOOL_MAP names tools not in TOOL_NAMES: ${unknown.join(", ")}`,
    );
  }
}
assertExactCoverage();
