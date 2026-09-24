import type { RunId } from "../../shared/domain/ids.js";
import type { RemediationDecision } from "./remediation-policy.js";
import type { RunnerOutcome } from "./runner-outcome.js";

/**
 * A completed (or failed) diagnostic execution as stored on a ticket
 * (bounded to the last 10, `Ticket.diagnostics`). `decision` is always
 * present — even a runner failure is fed through `decideRemediation`,
 * which defaults to `escalate` for any non-`completed` outcome (design
 * "Diagnostics ports and outcomes").
 */
export interface DiagnosticRun {
  readonly runId: RunId;
  readonly at: string;
  readonly outcome: RunnerOutcome;
  readonly decision: RemediationDecision;
}
