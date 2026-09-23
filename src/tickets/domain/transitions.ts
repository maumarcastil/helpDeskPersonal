import type { z } from "zod";
import { domainError, type DomainError } from "../../shared/domain-error.js";
import type { AuditId, RunId } from "../../shared/id-generator.js";
import { err, ok, type Result } from "../../shared/result.js";
import { canReopen } from "./reopen-policy.js";
import { canResolve, type EvidenceRun } from "./resolution-rule.js";
import { computePriority } from "./priority.js";
import { computeSlaDueDates } from "./sla.js";
import { STATE_RANK, type TicketState } from "./states.js";
import {
  ClosedPayloadSchema,
  EscalatedPayloadSchema,
  InProgressPayloadSchema,
  PendingUserConfirmationPayloadSchema,
  ReopenedPayloadSchema,
  ResolvedPayloadSchema,
  TriagedPayloadSchema,
  type ClosedPayload,
  type EscalatedPayload,
  type ResolvedPayload,
  type ReopenedPayload,
  type TriagedPayload,
} from "./transition-payloads.js";
import { AGENT_ACTORS, type Actor, type Ticket } from "./ticket.js";

export interface TransitionContext {
  readonly now: Date;
  /** The audit entry id the use case pre-generated for this transition. */
  readonly auditRef: AuditId;
  /**
   * The completed diagnostic re-check backing a `Resolved` transition with
   * `basis: "user-confirmed"`. Supplied by the use case (which has
   * repository access to resolve a `runId` to an actual run) — this
   * module stays a pure function of its explicit inputs.
   */
  readonly evidenceRun?: EvidenceRun;
}

export interface TransitionInput {
  readonly to: TicketState;
  readonly payload: unknown;
}

interface TransitionRule<P> {
  readonly from: TicketState;
  readonly to: TicketState;
  readonly actors: readonly Actor[];
  readonly payload: z.ZodType<P>;
  readonly guard?: (
    ticket: Ticket,
    payload: P,
    ctx: TransitionContext,
  ) => Result<void, DomainError>;
  readonly apply: (ticket: Ticket, payload: P, ctx: TransitionContext) => Ticket;
}

function defineRule<P>(rule: TransitionRule<P>): TransitionRule<unknown> {
  return rule as unknown as TransitionRule<unknown>;
}

function applyTriaged(ticket: Ticket, payload: TriagedPayload, ctx: TransitionContext): Ticket {
  const priorityResult = computePriority(payload.severity, payload.urgency);
  if (!priorityResult.ok) {
    // Unreachable: TriagedPayloadSchema already restricts severity/urgency
    // to the exact Level union computePriority accepts.
    throw new Error("unreachable: invalid severity/urgency reached applyTriaged");
  }
  const priority = priorityResult.value;
  return {
    ...ticket,
    state: "Triaged",
    summary: payload.summary,
    triage: {
      category: payload.category,
      subcategory: payload.subcategory,
      severity: payload.severity,
      urgency: payload.urgency,
      priority,
      sla: computeSlaDueDates(priority, ctx.now),
      // Phase 2's pseudonymizeUser tightens ref/display; Phase 1 stores
      // the raw supplied identifier in both fields.
      affectedUser: { ref: payload.affectedUser, display: payload.affectedUser },
      impactedService: payload.impactedService,
    },
  };
}

function applyInProgress(ticket: Ticket, _payload: unknown, _ctx: TransitionContext): Ticket {
  return { ...ticket, state: "InProgress" };
}

function applyPendingUserConfirmation(
  ticket: Ticket,
  _payload: unknown,
  ctx: TransitionContext,
): Ticket {
  // The "completed run referenced" guard and remediation-action echo check
  // (design's payload table) need the diagnostics capability's
  // DiagnosticRun/remediation-allowlist data, which does not exist until
  // Phase 2/3. Deferred to the Phase 2 TransitionTicket use case; the
  // PendingUserConfirmationPayloadSchema already enforces the payload is
  // structurally well-formed.
  return { ...ticket, state: "PendingUserConfirmation", pendingSince: ctx.now.toISOString() };
}

function applyEscalated(
  ticket: Ticket,
  payload: EscalatedPayload,
  ctx: TransitionContext,
): Ticket {
  const escalation: NonNullable<Ticket["escalation"]> =
    payload.note === undefined
      ? {
          reason: payload.escalationReason,
          target: payload.target,
          decisionLogRef: ctx.auditRef,
          at: ctx.now.toISOString(),
        }
      : {
          reason: payload.escalationReason,
          note: payload.note,
          target: payload.target,
          decisionLogRef: ctx.auditRef,
          at: ctx.now.toISOString(),
        };
  return { ...ticket, state: "Escalated", escalation };
}

function resolveGuard(
  ticket: Ticket,
  payload: ResolvedPayload,
  ctx: TransitionContext,
): Result<void, DomainError> {
  return canResolve(ticket, payload.basis, ctx.evidenceRun ?? null, ctx.now);
}

function applyResolved(
  ticket: Ticket,
  payload: ResolvedPayload,
  ctx: TransitionContext,
): Ticket {
  const resolution: NonNullable<Ticket["resolution"]> = payload.diagnosticEvidence
    ? {
        basis: payload.basis,
        evidenceRunId: payload.diagnosticEvidence.runId as RunId,
        resolvedAt: ctx.now.toISOString(),
      }
    : {
        basis: payload.basis,
        resolvedAt: ctx.now.toISOString(),
      };
  return { ...ticket, state: "Resolved", resolution };
}

function applyClosed(ticket: Ticket, payload: ClosedPayload, ctx: TransitionContext): Ticket {
  return {
    ...ticket,
    state: "Closed",
    closure: {
      resolutionSummary: payload.resolutionSummary,
      confirmationSource: payload.confirmationSource,
      closedAt: ctx.now.toISOString(),
    },
  };
}

function reopenGuard(
  ticket: Ticket,
  _payload: ReopenedPayload,
  ctx: TransitionContext,
): Result<void, DomainError> {
  return canReopen(ticket, ctx.now);
}

function applyReopened(
  ticket: Ticket,
  payload: ReopenedPayload,
  ctx: TransitionContext,
): Ticket {
  return {
    ...ticket,
    state: "Reopened",
    reopen: {
      count: (ticket.reopen?.count ?? 0) + 1,
      lastReason: payload.reopenReason,
      originalResolutionRef: payload.originalResolutionRef,
      reopenedAt: ctx.now.toISOString(),
    },
  };
}

/**
 * The full transition table (design "Transition table" / spec-v2
 * "Actor-Scoped Transitions"): 11 rows, each with its permitted actors,
 * strict payload schema, optional guard and pure `apply`.
 */
export const TRANSITION_RULES: ReadonlyArray<TransitionRule<unknown>> = [
  defineRule({
    from: "New",
    to: "Triaged",
    actors: ["triage"],
    payload: TriagedPayloadSchema,
    apply: applyTriaged,
  }),
  defineRule({
    from: "Triaged",
    to: "InProgress",
    actors: ["diagnostic", "escalation"],
    payload: InProgressPayloadSchema,
    apply: applyInProgress,
  }),
  defineRule({
    from: "Reopened",
    to: "InProgress",
    actors: ["diagnostic", "escalation"],
    payload: InProgressPayloadSchema,
    apply: applyInProgress,
  }),
  defineRule({
    from: "InProgress",
    to: "PendingUserConfirmation",
    actors: ["diagnostic"],
    payload: PendingUserConfirmationPayloadSchema,
    apply: applyPendingUserConfirmation,
  }),
  defineRule({
    from: "InProgress",
    to: "Escalated",
    actors: ["diagnostic", "escalation"],
    payload: EscalatedPayloadSchema,
    apply: applyEscalated,
  }),
  defineRule({
    from: "PendingUserConfirmation",
    to: "Escalated",
    actors: ["diagnostic", "escalation"],
    payload: EscalatedPayloadSchema,
    apply: applyEscalated,
  }),
  defineRule({
    from: "PendingUserConfirmation",
    to: "Resolved",
    actors: ["user", "system", "diagnostic"],
    payload: ResolvedPayloadSchema,
    guard: resolveGuard,
    apply: applyResolved,
  }),
  defineRule({
    from: "Escalated",
    to: "Resolved",
    actors: ["human-agent"],
    payload: ResolvedPayloadSchema,
    guard: resolveGuard,
    apply: applyResolved,
  }),
  defineRule({
    from: "Resolved",
    to: "Closed",
    actors: ["user", "system"],
    payload: ClosedPayloadSchema,
    apply: applyClosed,
  }),
  defineRule({
    from: "Resolved",
    to: "Reopened",
    actors: ["user"],
    payload: ReopenedPayloadSchema,
    guard: reopenGuard,
    apply: applyReopened,
  }),
  defineRule({
    from: "Closed",
    to: "Reopened",
    actors: ["user"],
    payload: ReopenedPayloadSchema,
    guard: reopenGuard,
    apply: applyReopened,
  }),
];

const ALL_STATES: readonly TicketState[] = [
  "New",
  "Triaged",
  "InProgress",
  "PendingUserConfirmation",
  "Escalated",
  "Resolved",
  "Closed",
  "Reopened",
];

function isTicketState(value: TicketState): value is TicketState {
  return (ALL_STATES as readonly string[]).includes(value);
}

export function allowedTargetsFrom(from: TicketState): readonly TicketState[] {
  return TRANSITION_RULES.filter((rule) => rule.from === from).map((rule) => rule.to);
}

/**
 * `applyTransition`: find rule (else `INVALID_TRANSITION` listing allowed
 * targets from the current state) -> actor in `rule.actors` (else
 * `ACTOR_NOT_PERMITTED`) -> zod parse (`VALIDATION_ERROR` with field
 * issues) -> guard -> apply, `version+1`, append history. Pure; the use
 * case persists and audits (Phase 2).
 *
 * The agent-actor forward-rank invariant is checked *before* the table
 * lookup, independent of whether `(from, to)` is even a valid row — spec
 * `ticket-lifecycle` -> "Actor-Scoped Transitions" requires this
 * independence explicitly.
 */
export function applyTransition(
  ticket: Ticket,
  input: TransitionInput,
  actor: Actor,
  ctx: TransitionContext,
): Result<Ticket, DomainError> {
  const from = ticket.state;
  const to = input.to;

  if (!isTicketState(to)) {
    return err(
      domainError("INVALID_TRANSITION", `"${String(to)}" is not a known ticket state`, {
        from,
        to,
      }),
    );
  }

  const isAgentActor = (AGENT_ACTORS as readonly Actor[]).includes(actor);
  if (isAgentActor && !(STATE_RANK[to] > STATE_RANK[from])) {
    return err(
      domainError(
        "ACTOR_NOT_PERMITTED",
        `agent actor "${actor}" cannot move a ticket from "${from}" to the equal-or-lower-rank state "${to}"`,
        { from, to, actor },
      ),
    );
  }

  const rule = TRANSITION_RULES.find((r) => r.from === from && r.to === to);
  if (!rule) {
    return err(
      domainError("INVALID_TRANSITION", `cannot transition from "${from}" to "${to}"`, {
        from,
        to,
        allowedTargets: allowedTargetsFrom(from),
      }),
    );
  }

  if (!rule.actors.includes(actor)) {
    return err(
      domainError(
        "ACTOR_NOT_PERMITTED",
        `actor "${actor}" is not permitted to transition a ticket from "${from}" to "${to}"`,
        { from, to, actor, permittedActors: rule.actors },
      ),
    );
  }

  const parsed = rule.payload.safeParse(input.payload);
  if (!parsed.success) {
    return err(
      domainError("VALIDATION_ERROR", "transition payload failed validation", {
        issues: parsed.error.issues,
      }),
    );
  }

  if (rule.guard) {
    const guardResult = rule.guard(ticket, parsed.data, ctx);
    if (!guardResult.ok) {
      return guardResult;
    }
  }

  const applied = rule.apply(ticket, parsed.data, ctx);
  const nextTicket: Ticket = {
    ...applied,
    version: ticket.version + 1,
    updatedAt: ctx.now.toISOString(),
    history: [
      ...ticket.history,
      { from, to, actor, at: ctx.now.toISOString(), auditRef: ctx.auditRef },
    ],
  };
  return ok(nextTicket);
}
