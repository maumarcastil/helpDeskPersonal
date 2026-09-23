import type { AuditId, TicketId } from "../../shared/domain/ids.js";
import type { AuditEntry } from "../domain/audit-entry.js";

/**
 * Append-only audit persistence port (implemented by `JsonlAuditLog`,
 * Phase 3). Deliberately exposes only `append`/`listByTicket` — no
 * update/delete method exists on this type at all, which is itself the
 * enforcement mechanism for spec `audit-decision-log` -> "Attempt to
 * modify a past entry is rejected" (there is nothing to call).
 *
 * The caller supplies `id` (minted via `IdGenerator.auditId()` before
 * calling `append`) rather than `append` generating it: this lets a use
 * case (e.g. `TransitionTicket`) know an audit entry's id up front, before
 * deciding whether to actually append it, without appending-then-discarding
 * a throwaway entry to learn an id. `seq`/`prevHash`/`hash` are still
 * assigned by the log itself.
 */
export interface AuditLog {
  append(entry: Omit<AuditEntry, "seq" | "prevHash" | "hash">): Promise<AuditId>;
  listByTicket(ticketId: TicketId): Promise<readonly AuditEntry[]>;
}
