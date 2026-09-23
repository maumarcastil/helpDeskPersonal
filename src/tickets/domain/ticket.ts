import type { RedactedText } from "../../redaction/domain/redacted-text.js";
import type { AuditId, RunId, TicketId } from "../../shared/domain/ids.js";
import type { Category, Subcategory } from "./categories.js";
import type { TicketState } from "./states.js";

/**
 * Re-exported so callers can `import type { TicketId } from
 * "tickets/domain/ticket.js"` per the design's module layout, even though
 * the branded type itself lives in `shared/id-generator.ts` (see that
 * file's header comment for why).
 */
export type { TicketId };

export type Level = "high" | "medium" | "low";
export type Priority = "P1" | "P2" | "P3";

export type Actor =
  | "triage"
  | "diagnostic"
  | "escalation"
  | "user"
  | "human-agent"
  | "system";

export const AGENT_ACTORS = ["triage", "diagnostic", "escalation"] as const;

/** Free-form for now; validated against the service catalog in Phase 3. */
export type ImpactedService = string;

export type EscalationReason =
  | "diagnostic_failed"
  | "service_unreachable"
  | "not_allowlisted"
  | "no_diagnostic_available"
  | "user_not_fixed"
  | "user_request";

export type EscalationTarget =
  | "identity-team"
  | "desktop-support"
  | "network-team"
  | "access-management";

export type ResolutionBasis = "user-confirmed" | "auto-timeout" | "human-agent";
export type ConfirmationSource = "user" | "auto-timeout";

/**
 * Opaque reference to a remediation-allowlist entry id. Phase 2's
 * `diagnostics/domain/remediation-allowlist.ts` defines the real closed
 * union; Phase 1 only needs to know remediation, when present, carries
 * *some* identifier — the mere presence of `Ticket.remediation` is what
 * `resolution-rule.ts` treats as "drawn from the allowlist", since the
 * only code path that will ever populate it (the Phase 2 `apply_remediation`
 * tool) enforces allowlist membership before setting it.
 */
export type RemediationActionRef = string;

export interface Ticket {
  readonly id: TicketId;
  readonly version: number;
  readonly state: TicketState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly description: RedactedText;
  readonly summary?: RedactedText;
  readonly relatedTicketId?: TicketId;
  readonly triage?: {
    readonly category: Category;
    readonly subcategory: Subcategory;
    readonly severity: Level;
    readonly urgency: Level;
    readonly priority: Priority;
    readonly sla: {
      readonly responseDueAt: string;
      readonly resolutionDueAt: string;
    };
    readonly affectedUser: { readonly ref: string; readonly display: string };
    readonly impactedService: ImpactedService;
  };
  /**
   * Bounded to the last 10 entries once populated (Phase 2/3 concern).
   * Phase 2's `diagnostics/domain/diagnostic-run.ts` supplies the real
   * `DiagnosticRun` shape; this minimal shape is enough for the
   * `PendingUserConfirmation -> Escalated`/`-> Resolved` guards Phase 1
   * exercises via a directly supplied `evidenceRun` parameter instead of
   * reading this array.
   */
  readonly diagnostics: ReadonlyArray<{ readonly runId: RunId; readonly at: string }>;
  readonly remediation?: {
    readonly action: RemediationActionRef;
    readonly runId: RunId;
    readonly appliedAt: string;
  };
  readonly pendingSince?: string;
  readonly escalation?: {
    readonly reason: EscalationReason;
    readonly note?: RedactedText;
    readonly target: EscalationTarget;
    readonly decisionLogRef: AuditId;
    readonly at: string;
  };
  readonly resolution?: {
    readonly basis: ResolutionBasis;
    readonly evidenceRunId?: RunId;
    readonly resolvedAt: string;
  };
  readonly closure?: {
    readonly resolutionSummary: RedactedText;
    readonly confirmationSource: ConfirmationSource;
    readonly closedAt: string;
  };
  readonly reopen?: {
    readonly count: number;
    readonly lastReason: RedactedText;
    readonly originalResolutionRef: string;
    readonly reopenedAt: string;
  };
  readonly systemState: {
    readonly accountUnlockSimulated: boolean;
    readonly resetLinkIssued: boolean;
    readonly serviceVerifiedHealthyAt?: string;
  };
  readonly history: ReadonlyArray<{
    readonly from: TicketState;
    readonly to: TicketState;
    readonly actor: Actor;
    readonly at: string;
    readonly auditRef: AuditId;
  }>;
}

/**
 * Pure constructor: takes the new ticket's id and the current instant as
 * plain values instead of `IdGenerator`/`Clock` ports, consistent with the
 * rest of the domain (e.g. `canReopen(t, now)`, `canResolve(t, ..., now)`).
 * The caller (application layer) resolves the id and the clock reading
 * through the actual ports before calling this constructor — no domain
 * file may import from `shared/ports/` (architecture guard).
 *
 * `description` is typed `RedactedText`, not `string` (design "Type-enforced
 * redaction", ADR 0008, point 2: "domain constructors accept only
 * RedactedText"). This slice only introduces the `redaction` domain itself
 * (tasks 2.1-2.3); the first real caller is the `CreateTicket` use case
 * (task 2.12, next slice), which calls `redact()` on the raw submitted text
 * and passes the result here — that is also where the redaction findings
 * get attached to the `ticket.created` audit entry.
 */
export function createNewTicket(description: RedactedText, id: TicketId, now: Date): Ticket {
  const nowIso = now.toISOString();
  return {
    id,
    version: 1,
    state: "New",
    createdAt: nowIso,
    updatedAt: nowIso,
    description,
    diagnostics: [],
    systemState: {
      accountUnlockSimulated: false,
      resetLinkIssued: false,
    },
    history: [],
  };
}
