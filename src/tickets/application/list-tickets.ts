import type { Category } from "../domain/categories.js";
import type { Priority, Ticket } from "../domain/ticket.js";
import type { TicketState } from "../domain/states.js";
import type { TicketRepository } from "../ports/ticket-repository.js";

const MAX_LIMIT = 50;

export interface ListTicketsInput {
  readonly state?: TicketState;
  readonly category?: Category;
  readonly priority?: Priority;
  readonly limit?: number;
}

export interface ListTicketsPorts {
  readonly ticketRepository: TicketRepository;
}

export interface ListTicketsOutput {
  readonly tickets: readonly Ticket[];
}

/**
 * `ListTickets` use case (design "Use cases" table). Enforces the hard cap
 * of 50 regardless of what the caller requests, before the filter ever
 * reaches the repository.
 */
export async function listTickets(
  ports: ListTicketsPorts,
  input: ListTicketsInput,
): Promise<ListTicketsOutput> {
  const limit = Math.min(input.limit ?? MAX_LIMIT, MAX_LIMIT);
  const tickets = await ports.ticketRepository.list({
    ...(input.state !== undefined ? { state: input.state } : {}),
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    limit,
  });
  return { tickets };
}
