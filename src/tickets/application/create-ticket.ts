import { redact } from "../../redaction/domain/redact.js";
import { domainError, type DomainError } from "../../shared/domain/domain-error.js";
import type { TicketId } from "../../shared/domain/ids.js";
import { err, ok, type Result } from "../../shared/kernel/result.js";
import type { Clock } from "../../shared/ports/clock.js";
import type { IdGenerator } from "../../shared/ports/id-generator.js";
import { recordAuditEntry } from "../../audit/application/audit-recorder.js";
import type { AuditLog } from "../../audit/ports/audit-log.js";
import { createNewTicket, type Ticket } from "../domain/ticket.js";
import type { TicketRepository } from "../ports/ticket-repository.js";

export interface CreateTicketInput {
  readonly text: string;
  readonly relatedTicketId?: TicketId;
}

export interface CreateTicketPorts {
  readonly ticketRepository: TicketRepository;
  readonly auditLog: AuditLog;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

export interface CreateTicketOutput {
  readonly ticket: Ticket;
}

/**
 * `CreateTicket` use case (design "Use cases" table). Redacts the free
 * text via `redact()` before it ever reaches `createNewTicket` (which only
 * accepts `RedactedText`, ADR 0008); `input.text` is redacted a second,
 * independent time inside `recordAuditEntry` for the audit trail — both
 * calls are the same pure function over the same raw string, so they
 * agree, and this keeps `recordAuditEntry` the single funnel every use
 * case's audit writes go through (no call site hand-builds an `AuditEntry`).
 */
export async function createTicket(
  ports: CreateTicketPorts,
  input: CreateTicketInput,
): Promise<Result<CreateTicketOutput, DomainError>> {
  if (input.relatedTicketId !== undefined) {
    const related = await ports.ticketRepository.getById(input.relatedTicketId);
    if (!related) {
      return err(
        domainError(
          "TICKET_NOT_FOUND",
          `relatedTicketId "${input.relatedTicketId}" does not exist`,
          { relatedTicketId: input.relatedTicketId },
        ),
      );
    }
  }

  const { text: description } = redact(input.text);
  const id = ports.idGenerator.ticketId();
  const now = ports.clock.now();
  const created = createNewTicket(description, id, now);
  const ticket: Ticket =
    input.relatedTicketId !== undefined
      ? { ...created, relatedTicketId: input.relatedTicketId }
      : created;

  // A brand-new ticket has no prior stored version; `expectedVersion: 0`
  // is this repository's convention for "must not already exist".
  const saveResult = await ports.ticketRepository.save(ticket, 0);
  if (!saveResult.ok) {
    return saveResult;
  }

  await recordAuditEntry(ports.auditLog, ports.clock, {
    id: ports.idGenerator.auditId(),
    ticketId: ticket.id,
    actor: "user",
    type: "ticket.created",
    message: input.text,
    ...(input.relatedTicketId !== undefined
      ? { data: { relatedTicketId: input.relatedTicketId } }
      : {}),
  });

  return ok({ ticket });
}
