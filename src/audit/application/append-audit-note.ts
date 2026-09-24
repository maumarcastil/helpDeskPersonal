import { domainError, type DomainError } from "../../shared/domain/domain-error.js";
import type { AuditId, TicketId } from "../../shared/domain/ids.js";
import { err, ok, type Result } from "../../shared/kernel/result.js";
import type { Clock } from "../../shared/ports/clock.js";
import type { IdGenerator } from "../../shared/ports/id-generator.js";
import type { Actor } from "../../tickets/domain/ticket.js";
import type { AuditLog } from "../ports/audit-log.js";
import { recordAuditEntry } from "./audit-recorder.js";

const MAX_MESSAGE_LENGTH = 1000;

export type AuditNoteKind = "note" | "agent_decision";

export interface AppendAuditNoteInput {
  readonly ticketId: TicketId;
  readonly actor: Actor;
  readonly kind: AuditNoteKind;
  readonly message: string;
}

export interface AppendAuditNotePorts {
  readonly auditLog: AuditLog;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

export interface AppendAuditNoteOutput {
  readonly auditRef: AuditId;
}

/**
 * `AppendAuditNote` use case (design "Use cases" table). Kind `note` maps
 * to `AuditEventType` `agent.note`, `agent_decision` maps to
 * `agent.decision`. Message is redacted by `recordAuditEntry` before it is
 * ever passed to the `AuditLog` port.
 */
export async function appendAuditNote(
  ports: AppendAuditNotePorts,
  input: AppendAuditNoteInput,
): Promise<Result<AppendAuditNoteOutput, DomainError>> {
  if (input.message.length > MAX_MESSAGE_LENGTH) {
    return err(
      domainError(
        "VALIDATION_ERROR",
        `message exceeds the ${MAX_MESSAGE_LENGTH}-character limit`,
        { length: input.message.length },
      ),
    );
  }

  const auditRef = await recordAuditEntry(ports.auditLog, ports.clock, {
    id: ports.idGenerator.auditId(),
    ticketId: input.ticketId,
    actor: input.actor,
    type: input.kind === "note" ? "agent.note" : "agent.decision",
    message: input.message,
  });

  return ok({ auditRef });
}
