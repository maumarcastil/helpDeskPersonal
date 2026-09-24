import { recordAuditEntry } from "../../audit/application/audit-recorder.js";
import type { AuditLog } from "../../audit/ports/audit-log.js";
import { domainError, type DomainError } from "../../shared/domain/domain-error.js";
import type { AuditId, RunId, TicketId } from "../../shared/domain/ids.js";
import { err, ok, type Result } from "../../shared/kernel/result.js";
import type { Clock } from "../../shared/ports/clock.js";
import type { IdGenerator } from "../../shared/ports/id-generator.js";
import type { Actor, Ticket } from "../../tickets/domain/ticket.js";
import type { TicketRepository } from "../../tickets/ports/ticket-repository.js";
import { ALLOWLIST, type RemediationAction } from "../domain/remediation-allowlist.js";

export interface ApplyRemediationInput {
  readonly ticketId: TicketId;
  readonly actor: Actor;
  readonly runId: RunId;
}

export interface ApplyRemediationPorts {
  readonly ticketRepository: TicketRepository;
  readonly auditLog: AuditLog;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

export interface ApplyRemediationOutput {
  readonly ticket: Ticket;
  readonly action: RemediationAction;
  readonly userMessage: string;
  /** The id of the `remediation.applied` audit entry this call appended
   *  (design "MCP tools" -> `apply_remediation` output: `{ticket, action,
   *  userMessage, auditRef}`). */
  readonly auditRef: AuditId;
}

/**
 * `ApplyRemediation` use case (design "Use cases" table; dedicated
 * `apply_remediation` tool with typed allowlist, ADR 0010). Deliberately
 * constructs the resulting ticket state directly (state, `pendingSince`,
 * `systemState`, `remediation`) rather than routing through
 * `applyTransition`'s `InProgress -> PendingUserConfirmation` row: this
 * use case already re-validates state and the referenced run itself, and
 * the allowlist `effect`/`action` are diagnostics-domain concepts that
 * `transitions.ts` (tickets domain) has no reason to know about.
 */
export async function applyRemediation(
  ports: ApplyRemediationPorts,
  input: ApplyRemediationInput,
): Promise<Result<ApplyRemediationOutput, DomainError>> {
  const ticket = await ports.ticketRepository.getById(input.ticketId);
  if (!ticket) {
    return err(domainError("TICKET_NOT_FOUND", `ticket "${input.ticketId}" does not exist`));
  }
  if (input.actor !== "diagnostic") {
    return err(
      domainError("ACTOR_NOT_PERMITTED", `actor "${input.actor}" cannot apply remediation`),
    );
  }
  if (ticket.state !== "InProgress") {
    return err(
      domainError(
        "DIAGNOSTIC_NOT_USABLE",
        `ticket must be InProgress to apply remediation, was "${ticket.state}"`,
      ),
    );
  }

  const run = ticket.diagnostics.find((d) => d.runId === input.runId);
  if (!run) {
    return err(
      domainError(
        "DIAGNOSTIC_NOT_USABLE",
        `referenced diagnostic run "${input.runId}" is not on this ticket`,
        { runId: input.runId },
      ),
    );
  }
  const decision = run.decision;
  if (decision.kind !== "remediate") {
    return err(
      domainError(
        "NOT_ALLOWLISTED",
        `diagnostic run "${input.runId}" has no matching remediation decision`,
        { runId: input.runId },
      ),
    );
  }

  const entry = ALLOWLIST.find((candidate) => candidate.id === decision.entryId);
  if (!entry) {
    // Defensive: decision.entryId always comes from ALLOWLIST itself.
    return err(
      domainError("NOT_ALLOWLISTED", `allowlist entry "${decision.entryId}" not found`),
    );
  }

  const now = ports.clock.now();
  const nowIso = now.toISOString();

  const auditRef = await recordAuditEntry(ports.auditLog, ports.clock, {
    id: ports.idGenerator.auditId(),
    ticketId: ticket.id,
    actor: input.actor,
    type: "remediation.applied",
    message: `remediation "${entry.action}" applied from allowlist entry "${entry.id}"`,
    data: { entryId: entry.id, action: entry.action, runId: input.runId },
  });

  const updatedTicket: Ticket = {
    ...ticket,
    state: "PendingUserConfirmation",
    pendingSince: nowIso,
    systemState: entry.effect(ticket.systemState, now),
    remediation: { action: entry.action, runId: input.runId, appliedAt: nowIso },
    version: ticket.version + 1,
    updatedAt: nowIso,
    history: [
      ...ticket.history,
      { from: ticket.state, to: "PendingUserConfirmation", actor: input.actor, at: nowIso, auditRef },
    ],
  };

  const saveResult = await ports.ticketRepository.save(updatedTicket, ticket.version);
  if (!saveResult.ok) {
    return saveResult;
  }

  return ok({
    ticket: updatedTicket,
    action: entry.action,
    userMessage: entry.userMessage,
    auditRef,
  });
}
