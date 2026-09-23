import { domainError, type DomainError } from "../../shared/domain/domain-error.js";
import { err, ok, type Result } from "../../shared/kernel/result.js";
import type { ResolutionBasis, Ticket } from "./ticket.js";

/**
 * A completed diagnostic re-check, supplied by the caller (use-case layer)
 * rather than read from `ticket.diagnostics` here — keeps this module a
 * pure function of its explicit inputs, and lets Phase 1 test it without
 * the diagnostics capability existing yet.
 */
export interface EvidenceRun {
  readonly completed: boolean;
  readonly status: "reachable" | "degraded" | "unreachable";
  readonly finishedAt: string; // ISO
}

const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

/**
 * A ticket is low-risk, for the 48-hour auto-timeout, only when its most
 * recently applied remediation was drawn from the allowlist AND its
 * priority is P3 AND its category is not access-identity (spec-v2
 * "Resolution Rule", override #6). Re-verified now that `ApplyRemediation`
 * (task 2.16, `src/diagnostics/application/apply-remediation.ts`) is the
 * only code path that ever sets `ticket.remediation`: it only reaches the
 * assignment after finding the referenced run's `decision.kind ===
 * "remediate"` AND resolving `decision.entryId` against `ALLOWLIST`
 * itself, so presence of `remediation` here still soundly implies "drawn
 * from the allowlist" — no other writer exists.
 */
function isLowRisk(ticket: Ticket): boolean {
  return (
    ticket.remediation !== undefined &&
    ticket.triage?.priority === "P3" &&
    ticket.triage?.category !== "access-identity"
  );
}

export function canResolve(
  ticket: Ticket,
  basis: ResolutionBasis,
  evidenceRun: EvidenceRun | null,
  now: Date,
): Result<void, DomainError> {
  switch (basis) {
    case "user-confirmed":
      return canResolveUserConfirmed(ticket, evidenceRun);
    case "auto-timeout":
      return canResolveAutoTimeout(ticket, now);
    case "human-agent":
      return canResolveHumanAgent(ticket);
  }
}

function canResolveUserConfirmed(
  ticket: Ticket,
  evidenceRun: EvidenceRun | null,
): Result<void, DomainError> {
  if (ticket.state !== "PendingUserConfirmation") {
    return err(
      domainError(
        "RESOLUTION_CONDITIONS_NOT_MET",
        "user-confirmed resolution requires the ticket to be in PendingUserConfirmation",
      ),
    );
  }
  if (!evidenceRun || !evidenceRun.completed || evidenceRun.status !== "reachable") {
    return err(
      domainError(
        "RESOLUTION_CONDITIONS_NOT_MET",
        "the diagnostic re-check has not passed",
      ),
    );
  }
  const anchor = ticket.remediation?.appliedAt ?? ticket.pendingSince;
  if (!anchor) {
    return err(
      domainError(
        "RESOLUTION_CONDITIONS_NOT_MET",
        "ticket has no pendingSince/remediation anchor to compare the re-check against",
      ),
    );
  }
  if (new Date(evidenceRun.finishedAt).getTime() < new Date(anchor).getTime()) {
    return err(
      domainError(
        "RESOLUTION_CONDITIONS_NOT_MET",
        "the diagnostic re-check predates the pending/remediation state",
      ),
    );
  }
  return ok(undefined);
}

function canResolveAutoTimeout(
  ticket: Ticket,
  now: Date,
): Result<void, DomainError> {
  if (ticket.state !== "PendingUserConfirmation" || !ticket.pendingSince) {
    return err(
      domainError(
        "RESOLUTION_CONDITIONS_NOT_MET",
        "auto-timeout resolution requires the ticket to be in PendingUserConfirmation with a pendingSince timestamp",
      ),
    );
  }
  const elapsedMs = now.getTime() - new Date(ticket.pendingSince).getTime();
  if (elapsedMs < FORTY_EIGHT_HOURS_MS) {
    return err(
      domainError(
        "RESOLUTION_CONDITIONS_NOT_MET",
        "the 48-hour auto-timeout window has not elapsed",
      ),
    );
  }
  if (!isLowRisk(ticket)) {
    return err(
      domainError(
        "RESOLUTION_CONDITIONS_NOT_MET",
        "auto-timeout only applies to a low-risk ticket (allowlisted remediation, priority P3, category != access-identity)",
      ),
    );
  }
  return ok(undefined);
}

function canResolveHumanAgent(ticket: Ticket): Result<void, DomainError> {
  if (ticket.state !== "Escalated") {
    return err(
      domainError(
        "RESOLUTION_CONDITIONS_NOT_MET",
        "human-agent resolution is only valid from Escalated",
      ),
    );
  }
  return ok(undefined);
}
