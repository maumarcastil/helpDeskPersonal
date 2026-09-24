import { redactDeep } from "../../redaction/domain/redact.js";
import type { Category } from "../../tickets/domain/categories.js";
import type { Actor, Priority, Ticket } from "../../tickets/domain/ticket.js";
import type { TicketState } from "../../tickets/domain/states.js";
import { TRANSITION_RULES } from "../../tickets/domain/transitions.js";

const HISTORY_LIMIT = 5;

export interface DiagnosticRunSummary {
  readonly runId: string;
  readonly at: string;
  readonly outcome: "completed" | "failed";
  readonly decisionKind: "remediate" | "escalate";
}

export type TicketView = Omit<Ticket, "history" | "diagnostics"> & {
  readonly history: Ticket["history"];
  readonly diagnostics: readonly DiagnosticRunSummary[];
};

/**
 * Shapes a stored `Ticket` for an MCP response (design "MCP tools":
 * "`TicketView` = Ticket with `history` truncated to the last 5 entries and
 * `diagnostics` reduced to summaries; `affectedUser.ref` is kept"). Every
 * caller still runs the result through `redactResponse` before returning it
 * to the client - this function only reshapes, it never redacts.
 */
export function toTicketView(ticket: Ticket): TicketView {
  return {
    ...ticket,
    history: ticket.history.slice(-HISTORY_LIMIT),
    diagnostics: ticket.diagnostics.map((run) => ({
      runId: run.runId,
      at: run.at,
      outcome: run.outcome.kind,
      decisionKind: run.decision.kind,
    })),
  };
}

export interface AllowedTransition {
  readonly to: TicketState;
  readonly actors: readonly Actor[];
}

/** The `get_ticket` output's `allowedTransitions` (design "MCP tools" output
 *  column): every transition-table row whose `from` matches the ticket's
 *  current state, reusing the same table `applyTransition` enforces so this
 *  can never drift from what an actual `update_ticket` call would accept. */
export function allowedTransitionsFor(state: TicketState): readonly AllowedTransition[] {
  return TRANSITION_RULES.filter((rule) => rule.from === state).map((rule) => ({
    to: rule.to,
    actors: rule.actors,
  }));
}

export interface TicketSummary {
  readonly id: string;
  readonly state: TicketState;
  readonly category?: Category;
  readonly priority?: Priority;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** `list_tickets`'s per-item shape (design references `TicketSummary[]`
 *  without pinning exact fields; kept intentionally small - enough to
 *  triage a list without the cost of a full `TicketView` per row). */
export function toTicketSummary(ticket: Ticket): TicketSummary {
  return {
    id: ticket.id,
    state: ticket.state,
    ...(ticket.triage
      ? { category: ticket.triage.category, priority: ticket.triage.priority }
      : {}),
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

/**
 * Redacts every string leaf of an already-shaped response payload. Defense
 * in depth (task 4.5): stored ticket text is already redacted at the point
 * it was written, but every tool response passes through this too, so a
 * future write-path regression cannot leak a secret through a read path.
 */
export function redactResponse<T>(value: T): T {
  return redactDeep(value);
}
