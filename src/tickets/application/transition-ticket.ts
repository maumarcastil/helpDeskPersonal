import { recordAuditEntry } from "../../audit/application/audit-recorder.js";
import type { AuditLog } from "../../audit/ports/audit-log.js";
import { redact } from "../../redaction/domain/redact.js";
import type { Pseudonymizer } from "../../redaction/ports/pseudonymizer.js";
import { domainError, type DomainError } from "../../shared/domain/domain-error.js";
import type { AuditId, TicketId } from "../../shared/domain/ids.js";
import { err, ok, type Result } from "../../shared/kernel/result.js";
import type { Clock } from "../../shared/ports/clock.js";
import type { IdGenerator } from "../../shared/ports/id-generator.js";
import type { EvidenceRun } from "../domain/resolution-rule.js";
import type { TicketState } from "../domain/states.js";
import type { Actor, Ticket } from "../domain/ticket.js";
import {
  PendingUserConfirmationPayloadSchema,
  ResolvedPayloadSchema,
  TriagedPayloadSchema,
} from "../domain/transition-payloads.js";
import { applyTransition, type TransitionContext } from "../domain/transitions.js";
import type { TicketRepository } from "../ports/ticket-repository.js";

export interface TransitionTicketInput {
  readonly ticketId: TicketId;
  readonly actor: Actor;
  readonly to: TicketState;
  readonly payload: unknown;
}

export interface TransitionTicketPorts {
  readonly ticketRepository: TicketRepository;
  readonly auditLog: AuditLog;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  /** Design "Use cases" -> TransitionTicket "Pseudonymizer(key)"; the key
   * is already bound into the adapter at construction (composition root). */
  readonly pseudonymizer: Pseudonymizer;
}

export interface TransitionTicketOutput {
  readonly ticket: Ticket;
  readonly auditRef: AuditId;
}

function buildContext(
  now: Date,
  auditRef: AuditId,
  evidenceRun: EvidenceRun | undefined,
  affectedUserPseudonym: TransitionContext["affectedUserPseudonym"],
): TransitionContext {
  return {
    now,
    auditRef,
    ...(evidenceRun !== undefined ? { evidenceRun } : {}),
    ...(affectedUserPseudonym !== undefined ? { affectedUserPseudonym } : {}),
  };
}

/**
 * `TransitionTicket` use case (design "Use cases" table). The audit id is
 * minted up front via `IdGenerator.auditId()`, so `applyTransition` (pure,
 * deterministic) runs exactly once — its result already carries the real
 * id as `ticket.history[].auditRef`, and as `escalation.decisionLogRef`
 * for `Escalated` specifically (override #5: server-generated, never
 * client-supplied). The real audit entry is appended only after the
 * optimistic-concurrency re-check and the `save` call both succeed, so a
 * transition that fails to save never leaves behind a success audit entry
 * — if the minted id ends up unused (rejection, conflict, or a failed
 * save), that is fine: ids are cheap and the rejection path mints and
 * appends its own separate audit entry.
 */
export async function transitionTicket(
  ports: TransitionTicketPorts,
  input: TransitionTicketInput,
): Promise<Result<TransitionTicketOutput, DomainError>> {
  const ticket = await ports.ticketRepository.getById(input.ticketId);
  if (!ticket) {
    return err(domainError("TICKET_NOT_FOUND", `ticket "${input.ticketId}" does not exist`));
  }

  const guardResult = checkPendingUserConfirmationGuard(ticket, input.to, input.payload);
  if (!guardResult.ok) {
    await auditRejection(ports, ticket, input, guardResult.error);
    return guardResult;
  }

  const now = ports.clock.now();
  const affectedUserPseudonym = resolveAffectedUserPseudonym(ports.pseudonymizer, input);
  const evidenceRun = resolveEvidenceRun(ticket, input.payload);
  const redactedPayload = redactFreeTextFields(input.to, input.payload);
  const auditRef = ports.idGenerator.auditId();

  const transitionResult = applyTransition(
    ticket,
    { to: input.to, payload: redactedPayload },
    input.actor,
    buildContext(now, auditRef, evidenceRun, affectedUserPseudonym),
  );
  if (!transitionResult.ok) {
    await auditRejection(ports, ticket, input, transitionResult.error);
    return transitionResult;
  }

  // Optimistic-concurrency re-check, right before committing to the
  // success path: re-fetch and compare against the version we originally
  // loaded, so a concurrent writer's already-saved change is caught
  // *before* a success audit entry is appended. This narrows, but per
  // design's "Open Questions" does not fully eliminate, the race between
  // this check and the `save` call a few lines below.
  const current = await ports.ticketRepository.getById(input.ticketId);
  if (!current || current.version !== ticket.version) {
    const conflictError = domainError(
      "CONFLICT",
      "ticket was modified by another writer since it was loaded",
      { ticketId: ticket.id },
    );
    await auditRejection(ports, ticket, input, conflictError);
    return err(conflictError);
  }

  const saveResult = await ports.ticketRepository.save(transitionResult.value, ticket.version);
  if (!saveResult.ok) {
    await auditRejection(ports, ticket, input, saveResult.error);
    return saveResult;
  }

  await recordAuditEntry(ports.auditLog, ports.clock, {
    id: auditRef,
    ticketId: ticket.id,
    actor: input.actor,
    type: "ticket.transitioned",
    message: `ticket transitioned from ${ticket.state} to ${input.to}`,
    data: { from: ticket.state, to: input.to },
  });

  return ok({ ticket: transitionResult.value, auditRef });
}

async function auditRejection(
  ports: TransitionTicketPorts,
  ticket: Ticket,
  input: TransitionTicketInput,
  error: DomainError,
): Promise<void> {
  await recordAuditEntry(ports.auditLog, ports.clock, {
    id: ports.idGenerator.auditId(),
    ticketId: ticket.id,
    actor: input.actor,
    type: "transition.rejected",
    message: `transition from ${ticket.state} to ${input.to} rejected: ${error.message}`,
    data: { from: ticket.state, to: input.to, code: error.code },
  });
}

function resolveAffectedUserPseudonym(
  pseudonymizer: Pseudonymizer,
  input: TransitionTicketInput,
): TransitionContext["affectedUserPseudonym"] {
  if (input.to !== "Triaged") return undefined;
  const parsed = TriagedPayloadSchema.safeParse(input.payload);
  if (!parsed.success) return undefined;
  return pseudonymizer.pseudonymize(parsed.data.affectedUser);
}

function resolveEvidenceRun(ticket: Ticket, payload: unknown): EvidenceRun | undefined {
  const parsed = ResolvedPayloadSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.diagnosticEvidence) return undefined;
  const run = ticket.diagnostics.find(
    (d) => d.runId === parsed.data.diagnosticEvidence?.runId,
  );
  if (!run || run.outcome.kind !== "completed") return undefined;
  return {
    completed: true,
    status: run.outcome.report.status,
    finishedAt: run.outcome.report.finishedAt,
  };
}

/**
 * Carry-over from Phase 1 (open issue flagged in `apply-progress.md`):
 * `InProgress -> PendingUserConfirmation` requires the payload's
 * `diagnosticEvidence.runId` to reference a completed `DiagnosticRun`
 * actually stored on this ticket. `applyTransition` cannot check this
 * itself (pure; `ticket.diagnostics` — already loaded here — is the only
 * place a `DiagnosticRun` can be found, there is no separate repository).
 * Checked before calling `applyTransition` so a failure still goes through
 * the normal rejection-audit path.
 */
function checkPendingUserConfirmationGuard(
  ticket: Ticket,
  to: TicketState,
  payload: unknown,
): Result<void, DomainError> {
  if (to !== "PendingUserConfirmation") {
    return ok(undefined);
  }
  const parsed = PendingUserConfirmationPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    // Malformed payload: let applyTransition's own zod parse produce the
    // VALIDATION_ERROR with field-level issues instead of masking it here.
    return ok(undefined);
  }
  const referencedRunId = parsed.data.diagnosticEvidence.runId;
  const run = ticket.diagnostics.find((d) => d.runId === referencedRunId);
  if (!run || run.outcome.kind !== "completed") {
    return err(
      domainError(
        "DIAGNOSTIC_NOT_USABLE",
        `referenced diagnostic run "${referencedRunId}" is not a completed run on this ticket`,
        { runId: referencedRunId },
      ),
    );
  }
  return ok(undefined);
}

const FREE_TEXT_KEYS_BY_TARGET: Partial<Record<TicketState, readonly string[]>> = {
  Triaged: ["summary"],
  InProgress: ["note"],
  Escalated: ["note"],
  Closed: ["resolutionSummary"],
  Reopened: ["reopenReason"],
};

/**
 * Redacts the free-text fields of the payload before it is ever passed to
 * `applyTransition` (ADR 0008: a value must be redacted before it can
 * reach a `RedactedText`-typed domain field). `applyTransition`'s own zod
 * parse still validates the full shape; this only rewrites known
 * free-text keys when present.
 */
function redactFreeTextFields(to: TicketState, payload: unknown): unknown {
  if (payload === null || typeof payload !== "object") {
    return payload;
  }
  const freeTextKeys = FREE_TEXT_KEYS_BY_TARGET[to] ?? [];
  if (freeTextKeys.length === 0) {
    return payload;
  }
  const result: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const key of freeTextKeys) {
    const value = result[key];
    if (typeof value === "string") {
      result[key] = redact(value).text;
    }
  }
  return result;
}
