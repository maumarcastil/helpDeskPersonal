import type { DomainError } from "../../shared/domain/domain-error.js";
import type { TicketId } from "../../shared/domain/ids.js";
import type { Result } from "../../shared/kernel/result.js";
import type { Category } from "../domain/categories.js";
import type { Priority, Ticket } from "../domain/ticket.js";
import type { TicketState } from "../domain/states.js";

export interface TicketListFilter {
  readonly state?: TicketState;
  readonly category?: Category;
  readonly priority?: Priority;
  /** Caller-requested cap; the use case (`ListTickets`, task 2.14) enforces the hard max of 50. */
  readonly limit?: number;
}

/**
 * Persistence port for tickets (implemented by `JsonFileTicketRepository`,
 * Phase 3). `save` takes the caller's `expectedVersion` and MUST return a
 * `CONFLICT` `DomainError` (not throw, not silently overwrite) when the
 * repository's current stored version no longer matches — the optimistic
 * concurrency control spec-v2 requires (override #5).
 */
export interface TicketRepository {
  getById(id: TicketId): Promise<Ticket | null>;
  save(ticket: Ticket, expectedVersion: number): Promise<Result<void, DomainError>>;
  list(filter: TicketListFilter): Promise<readonly Ticket[]>;
}
