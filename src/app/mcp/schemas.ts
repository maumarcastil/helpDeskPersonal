import { z } from "zod";

/** Shared zod raw-shape building blocks for the 7 MCP tools (design "MCP
 *  tools" input column). Kept separate from the domain's own payload
 *  schemas (`tickets/domain/transition-payloads.ts`) deliberately: this
 *  layer only validates the outer MCP envelope shape (ids, actor, which
 *  target state), never the per-transition payload fields - that strict
 *  validation stays in `applyTransition`, the single source of truth,
 *  so the MCP boundary can never drift from the domain rule it delegates to. */
export const TicketStateSchema = z.enum([
  "New",
  "Triaged",
  "InProgress",
  "PendingUserConfirmation",
  "Escalated",
  "Resolved",
  "Closed",
  "Reopened",
]);

export const ActorSchema = z.enum([
  "triage",
  "diagnostic",
  "escalation",
  "user",
  "human-agent",
  "system",
]);

export const CategorySchema = z.enum([
  "access-identity",
  "infrastructure-software",
  "provisioning-permissions",
]);

export const PrioritySchema = z.enum(["P1", "P2", "P3"]);
