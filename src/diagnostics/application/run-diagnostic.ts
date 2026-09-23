import { recordAuditEntry } from "../../audit/application/audit-recorder.js";
import type { AuditLog } from "../../audit/ports/audit-log.js";
import { domainError, type DomainError } from "../../shared/domain/domain-error.js";
import type { RunId, TicketId } from "../../shared/domain/ids.js";
import { err, ok, type Result } from "../../shared/kernel/result.js";
import type { Clock } from "../../shared/ports/clock.js";
import type { IdGenerator } from "../../shared/ports/id-generator.js";
import type { Actor, Ticket } from "../../tickets/domain/ticket.js";
import type { TicketRepository } from "../../tickets/ports/ticket-repository.js";
import type { DiagnosticRun } from "../domain/diagnostic-run.js";
import { decideRemediation, type RemediationDecision } from "../domain/remediation-policy.js";
import type { RunnerFailureReason } from "../domain/runner-outcome.js";
import type { DiagnosticRunner } from "../ports/diagnostic-runner.js";
import type { ServiceCatalog } from "../ports/service-catalog.js";

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_STORED_RUNS = 10;

export interface RunDiagnosticInput {
  readonly ticketId: TicketId;
  readonly actor: Actor;
}

export interface RunDiagnosticPorts {
  readonly ticketRepository: TicketRepository;
  readonly serviceCatalog: ServiceCatalog;
  readonly diagnosticRunner: DiagnosticRunner;
  readonly auditLog: AuditLog;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly timeoutMs?: number;
}

export interface RunDiagnosticOutput {
  readonly runId?: RunId;
  readonly outcome?: "completed" | "failed";
  readonly failureReason?: RunnerFailureReason;
  readonly decision: RemediationDecision;
}

/**
 * `RunDiagnostic` use case (design "Use cases" table). Never mutates
 * `ticket.state`; only appends to `ticket.diagnostics` (bounded to the
 * last 10). Runner failures are turned into an `escalate` decision
 * directly, without ever being passed to `decideRemediation` (spec
 * `diagnostic-execution` -> "Runner failure never reaches the remediation
 * allowlist as a diagnosticResult").
 */
export async function runDiagnostic(
  ports: RunDiagnosticPorts,
  input: RunDiagnosticInput,
): Promise<Result<RunDiagnosticOutput, DomainError>> {
  const ticket = await ports.ticketRepository.getById(input.ticketId);
  if (!ticket) {
    return err(domainError("TICKET_NOT_FOUND", `ticket "${input.ticketId}" does not exist`));
  }
  if (input.actor !== "diagnostic") {
    return err(
      domainError("ACTOR_NOT_PERMITTED", `actor "${input.actor}" cannot run a diagnostic`),
    );
  }
  if (ticket.state !== "InProgress" && ticket.state !== "PendingUserConfirmation") {
    return err(
      domainError(
        "DIAGNOSTIC_NOT_USABLE",
        `ticket must be InProgress or PendingUserConfirmation to run a diagnostic, was "${ticket.state}"`,
      ),
    );
  }
  if (!ticket.triage) {
    return err(domainError("VALIDATION_ERROR", "ticket has not been triaged yet"));
  }

  const target = ports.serviceCatalog.resolve(ticket.triage.impactedService);
  if (!target) {
    const decision: RemediationDecision = { kind: "escalate", reason: "no_diagnostic_available" };
    await recordAuditEntry(ports.auditLog, ports.clock, {
      id: ports.idGenerator.auditId(),
      ticketId: ticket.id,
      actor: input.actor,
      type: "diagnostic.failed",
      message: `no diagnostic available for service "${ticket.triage.impactedService}"`,
      data: { impactedService: ticket.triage.impactedService, decision },
    });
    return ok({ decision });
  }

  const runId = ports.idGenerator.runId();
  const outcome = await ports.diagnosticRunner.run({
    probe: "connectivity",
    target,
    timeoutMs: ports.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  const decision: RemediationDecision =
    outcome.kind === "completed"
      ? decideRemediation({
          category: ticket.triage.category,
          subcategory: ticket.triage.subcategory,
          probe: "connectivity",
          status: outcome.report.status,
        })
      : { kind: "escalate", reason: "diagnostic_failed" };

  const diagnosticRun: DiagnosticRun = {
    runId,
    at: ports.clock.now().toISOString(),
    outcome,
    decision,
  };
  const diagnostics = [...ticket.diagnostics, diagnosticRun].slice(-MAX_STORED_RUNS);
  const updatedTicket: Ticket = {
    ...ticket,
    diagnostics,
    version: ticket.version + 1,
    updatedAt: ports.clock.now().toISOString(),
  };
  await ports.ticketRepository.save(updatedTicket, ticket.version);

  await recordAuditEntry(ports.auditLog, ports.clock, {
    id: ports.idGenerator.auditId(),
    ticketId: ticket.id,
    actor: input.actor,
    type: outcome.kind === "completed" ? "diagnostic.completed" : "diagnostic.failed",
    message:
      outcome.kind === "completed"
        ? `diagnostic run completed with status "${outcome.report.status}"`
        : `diagnostic run failed: ${outcome.reason}`,
    data: { runId, decision },
  });

  return ok({
    runId,
    outcome: outcome.kind,
    ...(outcome.kind === "failed" ? { failureReason: outcome.reason } : {}),
    decision,
  });
}
