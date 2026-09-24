import { describe, expect, it } from "vitest";
import type { AuditId } from "../../shared/domain/ids.js";
import type { EvidenceRun } from "./resolution-rule.js";
import { STATE_RANK, type TicketState } from "./states.js";
import {
  applyTransition,
  TRANSITION_RULES,
  type TransitionContext,
} from "./transitions.js";
import type { Actor, Ticket } from "./ticket.js";

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

const AGENT_ACTORS: readonly Actor[] = ["triage", "diagnostic", "escalation"];

function baseTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "tkt_1" as Ticket["id"],
    version: 1,
    state: "New",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    description: "vpn is down" as Ticket["description"],
    diagnostics: [],
    systemState: { accountUnlockSimulated: false, resetLinkIssued: false },
    history: [],
    ...overrides,
  };
}

function ctx(overrides: Partial<TransitionContext> = {}): TransitionContext {
  return {
    now: new Date("2026-01-05T00:00:00.000Z"),
    auditRef: "aud_1" as AuditId,
    ...overrides,
  };
}

const passingEvidence: EvidenceRun = {
  completed: true,
  status: "reachable",
  finishedAt: "2026-01-05T00:00:00.000Z",
};

describe("applyTransition — every table row succeeds with a correct actor and valid payload", () => {
  it("New -> Triaged (actor: triage)", () => {
    const result = applyTransition(
      baseTicket({ state: "New" }),
      {
        to: "Triaged",
        payload: {
          category: "infrastructure-software",
          subcategory: "vpn",
          severity: "high",
          urgency: "medium",
          affectedUser: "j.doe",
          impactedService: "vpn-gateway",
          summary: "VPN drops",
        },
      },
      "triage",
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.state).toBe("Triaged");
      expect(result.value.triage?.priority).toBe("P1");
      expect(result.value.version).toBe(2);
      expect(result.value.history).toHaveLength(1);
      expect(result.value.history[0]).toEqual({
        from: "New",
        to: "Triaged",
        actor: "triage",
        at: "2026-01-05T00:00:00.000Z",
        auditRef: "aud_1",
      });
    }
  });

  it("Triaged -> InProgress (actor: diagnostic)", () => {
    const result = applyTransition(
      baseTicket({ state: "Triaged" }),
      { to: "InProgress", payload: {} },
      "diagnostic",
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.state).toBe("InProgress");
  });

  it("Reopened -> InProgress (actor: escalation)", () => {
    const result = applyTransition(
      baseTicket({ state: "Reopened" }),
      { to: "InProgress", payload: {} },
      "escalation",
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.state).toBe("InProgress");
  });

  it("InProgress -> PendingUserConfirmation (actor: diagnostic)", () => {
    const result = applyTransition(
      baseTicket({ state: "InProgress" }),
      {
        to: "PendingUserConfirmation",
        payload: {
          diagnosticEvidence: { runId: "run_1" },
          remediationAction: null,
          timestamp: new Date().toISOString(),
        },
      },
      "diagnostic",
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.state).toBe("PendingUserConfirmation");
      expect(result.value.pendingSince).toBe("2026-01-05T00:00:00.000Z");
    }
  });

  it("InProgress -> Escalated (actor: diagnostic)", () => {
    const result = applyTransition(
      baseTicket({ state: "InProgress" }),
      {
        to: "Escalated",
        payload: { escalationReason: "service_unreachable", target: "network-team" },
      },
      "diagnostic",
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.state).toBe("Escalated");
      expect(result.value.escalation?.decisionLogRef).toBe("aud_1");
    }
  });

  it("PendingUserConfirmation -> Escalated (actor: escalation)", () => {
    const result = applyTransition(
      baseTicket({ state: "PendingUserConfirmation" }),
      {
        to: "Escalated",
        payload: { escalationReason: "user_not_fixed", target: "desktop-support" },
      },
      "escalation",
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.state).toBe("Escalated");
  });

  it("PendingUserConfirmation -> Resolved (actor: user, basis: user-confirmed)", () => {
    const ticket = baseTicket({
      state: "PendingUserConfirmation",
      pendingSince: "2026-01-04T00:00:00.000Z",
    });
    const result = applyTransition(
      ticket,
      {
        to: "Resolved",
        payload: { basis: "user-confirmed", timestamp: new Date().toISOString() },
      },
      "user",
      ctx({ evidenceRun: passingEvidence }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.state).toBe("Resolved");
      expect(result.value.resolution?.basis).toBe("user-confirmed");
    }
  });

  it("Escalated -> Resolved (actor: human-agent, basis: human-agent)", () => {
    const ticket = baseTicket({ state: "Escalated" });
    const result = applyTransition(
      ticket,
      {
        to: "Resolved",
        payload: { basis: "human-agent", timestamp: new Date().toISOString() },
      },
      "human-agent",
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.state).toBe("Resolved");
      expect(result.value.resolution?.basis).toBe("human-agent");
    }
  });

  it("Resolved -> Closed (actor: user)", () => {
    const result = applyTransition(
      baseTicket({ state: "Resolved" }),
      {
        to: "Closed",
        payload: { resolutionSummary: "fixed", confirmationSource: "user" },
      },
      "user",
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.state).toBe("Closed");
  });

  it("Resolved -> Reopened (actor: user)", () => {
    const ticket = baseTicket({
      state: "Resolved",
      resolution: { basis: "user-confirmed", resolvedAt: "2026-01-04T00:00:00.000Z" },
    });
    const result = applyTransition(
      ticket,
      {
        to: "Reopened",
        payload: { reopenReason: "still broken", originalResolutionRef: "tkt_1" },
      },
      "user",
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.state).toBe("Reopened");
  });

  it("Closed -> Reopened (actor: user)", () => {
    const ticket = baseTicket({
      state: "Closed",
      resolution: { basis: "user-confirmed", resolvedAt: "2026-01-04T00:00:00.000Z" },
    });
    const result = applyTransition(
      ticket,
      {
        to: "Reopened",
        payload: { reopenReason: "still broken", originalResolutionRef: "tkt_1" },
      },
      "user",
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.state).toBe("Reopened");
  });

  it("TRANSITION_RULES has exactly the 11 rows from the design table", () => {
    expect(TRANSITION_RULES).toHaveLength(11);
  });
});

describe("applyTransition — invalid (from,to) pairs", () => {
  const validRows = new Set(
    TRANSITION_RULES.map((r) => `${r.from}->${r.to}`),
  );

  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      if (validRows.has(`${from}->${to}`)) continue;
      it(`rejects ${from} -> ${to} with INVALID_TRANSITION`, () => {
        const result = applyTransition(
          baseTicket({ state: from }),
          { to, payload: {} },
          "system",
          ctx(),
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("INVALID_TRANSITION");
        }
      });
    }
  }

  it("rejects a transition to an unknown state", () => {
    const result = applyTransition(
      baseTicket({ state: "New" }),
      { to: "NotAState" as TicketState, payload: {} },
      "triage",
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_TRANSITION");
  });
});

describe("applyTransition — actor enforcement", () => {
  it("rejects a wrong actor with ACTOR_NOT_PERMITTED", () => {
    const result = applyTransition(
      baseTicket({ state: "Triaged" }),
      { to: "InProgress", payload: {} },
      "user",
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ACTOR_NOT_PERMITTED");
  });

  it("rejects Reopened for actor system (not user)", () => {
    const ticket = baseTicket({
      state: "Resolved",
      resolution: { basis: "user-confirmed", resolvedAt: "2026-01-04T00:00:00.000Z" },
    });
    const result = applyTransition(
      ticket,
      {
        to: "Reopened",
        payload: { reopenReason: "still broken", originalResolutionRef: "tkt_1" },
      },
      "system",
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ACTOR_NOT_PERMITTED");
  });

  it("rejects Reopened for actor human-agent (not user)", () => {
    const ticket = baseTicket({
      state: "Closed",
      resolution: { basis: "user-confirmed", resolvedAt: "2026-01-04T00:00:00.000Z" },
    });
    const result = applyTransition(
      ticket,
      {
        to: "Reopened",
        payload: { reopenReason: "still broken", originalResolutionRef: "tkt_1" },
      },
      "human-agent",
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ACTOR_NOT_PERMITTED");
  });

  it("rejects a non-human-agent actor for Escalated -> Resolved", () => {
    const result = applyTransition(
      baseTicket({ state: "Escalated" }),
      {
        to: "Resolved",
        payload: { basis: "human-agent", timestamp: new Date().toISOString() },
      },
      "diagnostic",
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ACTOR_NOT_PERMITTED");
  });
});

describe("applyTransition — agent actors are forward-only (defense in depth)", () => {
  it("every table row permitting an agent actor is strictly forward-rank", () => {
    for (const r of TRANSITION_RULES) {
      const hasAgentActor = r.actors.some((a) => AGENT_ACTORS.includes(a));
      if (hasAgentActor) {
        expect(STATE_RANK[r.to]).toBeGreaterThan(STATE_RANK[r.from]);
      }
    }
  });

  it("rejects an agent actor moving to an equal-or-lower-rank state even when that pair isn't in the table at all", () => {
    // InProgress (rank 2) -> Triaged (rank 1): not a table row, and backward-rank.
    const result = applyTransition(
      baseTicket({ state: "InProgress" }),
      { to: "Triaged", payload: {} },
      "diagnostic",
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ACTOR_NOT_PERMITTED");
  });
});
