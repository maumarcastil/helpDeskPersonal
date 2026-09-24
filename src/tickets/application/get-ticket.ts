import { domainError, type DomainError } from "../../shared/domain/domain-error.js";
import type { TicketId } from "../../shared/domain/ids.js";
import { err, ok, type Result } from "../../shared/kernel/result.js";
import type { Ticket } from "../domain/ticket.js";
import type { TicketRepository } from "../ports/ticket-repository.js";

export interface GetTicketInput {
  readonly ticketId: TicketId;
}

export interface GetTicketPorts {
  readonly ticketRepository: TicketRepository;
}

export interface GetTicketOutput {
  readonly ticket: Ticket;
}

/** `GetTicket` use case (design "Use cases" table). */
export async function getTicket(
  ports: GetTicketPorts,
  input: GetTicketInput,
): Promise<Result<GetTicketOutput, DomainError>> {
  const ticket = await ports.ticketRepository.getById(input.ticketId);
  if (!ticket) {
    return err(domainError("TICKET_NOT_FOUND", `ticket "${input.ticketId}" does not exist`));
  }
  return ok({ ticket });
}
