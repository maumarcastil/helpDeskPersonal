import { domainError, type DomainError } from "../../shared/domain-error.js";
import { err, ok, type Result } from "../../shared/result.js";
import type { Ticket } from "./ticket.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A `Resolved`/`Closed` ticket may reopen only within 7 calendar days of
 * its resolution timestamp (spec `ticket-lifecycle` -> Requirement
 * "Reopen Window"). Boundary is inclusive: exactly 168h is allowed.
 */
export function canReopen(ticket: Ticket, now: Date): Result<void, DomainError> {
  if (!ticket.resolution) {
    return err(
      domainError(
        "REOPEN_WINDOW_EXPIRED",
        "ticket has never been resolved, so it cannot be reopened",
      ),
    );
  }
  const elapsedMs = now.getTime() - new Date(ticket.resolution.resolvedAt).getTime();
  if (elapsedMs > SEVEN_DAYS_MS) {
    return err(
      domainError(
        "REOPEN_WINDOW_EXPIRED",
        "the 7-day reopen window has expired",
        {
          suggestion:
            "create_ticket with relatedTicketId referencing the original ticket",
        },
      ),
    );
  }
  return ok(undefined);
}
