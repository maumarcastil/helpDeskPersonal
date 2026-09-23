import { describe, expect, it } from "vitest";
import { canResolve, type EvidenceRun } from "./resolution-rule.js";
import type { Ticket } from "./ticket.js";

function baseTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "tkt_1" as Ticket["id"],
    version: 1,
    state: "PendingUserConfirmation",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    description: "vpn is down" as Ticket["description"],
    diagnostics: [],
    systemState: { accountUnlockSimulated: false, resetLinkIssued: false },
    history: [],
    pendingSince: "2026-01-01T00:00:00.000Z",
    triage: {
      category: "infrastructure-software",
      subcategory: "vpn",
      severity: "medium",
      urgency: "medium",
      priority: "P3",
      sla: { responseDueAt: "x", resolutionDueAt: "y" },
      affectedUser: { ref: "usr_1", display: "u***1" },
      impactedService: "vpn-gateway",
    },
    ...overrides,
  };
}

const passingEvidence: EvidenceRun = {
  completed: true,
  status: "reachable",
  finishedAt: "2026-01-01T01:00:00.000Z",
};

describe("canResolve — user-confirmed", () => {
  it("succeeds when the diagnostic re-check passed after pendingSince (no remediation)", () => {
    const ticket = baseTicket();
    const result = canResolve(
      ticket,
      "user-confirmed",
      passingEvidence,
      new Date("2026-01-01T02:00:00.000Z"),
    );
    expect(result.ok).toBe(true);
  });

  it("succeeds when the diagnostic re-check passed after remediation.appliedAt", () => {
    const ticket = baseTicket({
      remediation: {
        action: "vpn-gateway-up",
        runId: "run_1" as Ticket["remediation"] extends undefined
          ? never
          : NonNullable<Ticket["remediation"]>["runId"],
        appliedAt: "2026-01-01T00:30:00.000Z",
      },
    });
    const result = canResolve(
      ticket,
      "user-confirmed",
      passingEvidence,
      new Date("2026-01-01T02:00:00.000Z"),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects when the diagnostic re-check has not passed", () => {
    const ticket = baseTicket();
    const failingEvidence: EvidenceRun = {
      completed: true,
      status: "unreachable",
      finishedAt: "2026-01-01T01:00:00.000Z",
    };
    const result = canResolve(
      ticket,
      "user-confirmed",
      failingEvidence,
      new Date("2026-01-01T02:00:00.000Z"),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects when there is no evidence run at all", () => {
    const ticket = baseTicket();
    const result = canResolve(
      ticket,
      "user-confirmed",
      null,
      new Date("2026-01-01T02:00:00.000Z"),
    );
    expect(result.ok).toBe(false);
  });
});

describe("canResolve — auto-timeout", () => {
  const lowRiskTicket = baseTicket({
    remediation: {
      action: "vpn-gateway-up",
      runId: "run_1" as never,
      appliedAt: "2026-01-01T00:10:00.000Z",
    },
  });

  it("succeeds at exactly 48 hours for a low-risk ticket (boundary inclusive)", () => {
    const at48h = new Date(
      new Date("2026-01-01T00:00:00.000Z").getTime() + 48 * 60 * 60 * 1000,
    );
    const result = canResolve(lowRiskTicket, "auto-timeout", null, at48h);
    expect(result.ok).toBe(true);
  });

  it("fails one tick (1ms) before the 48-hour mark", () => {
    const beforeBoundary = new Date(
      new Date("2026-01-01T00:00:00.000Z").getTime() + 48 * 60 * 60 * 1000 - 1,
    );
    const result = canResolve(
      lowRiskTicket,
      "auto-timeout",
      null,
      beforeBoundary,
    );
    expect(result.ok).toBe(false);
  });

  it("does not apply when the ticket has no allowlisted remediation", () => {
    const notAllowlisted = baseTicket();
    const at48h = new Date(
      new Date("2026-01-01T00:00:00.000Z").getTime() + 48 * 60 * 60 * 1000,
    );
    const result = canResolve(notAllowlisted, "auto-timeout", null, at48h);
    expect(result.ok).toBe(false);
  });

  it("does not apply to a P2 ticket even when allowlisted", () => {
    const p2 = baseTicket({
      remediation: {
        action: "vpn-gateway-up",
        runId: "run_1" as never,
        appliedAt: "2026-01-01T00:10:00.000Z",
      },
      triage: {
        ...(lowRiskTicket.triage as NonNullable<Ticket["triage"]>),
        priority: "P2",
      },
    });
    const at48h = new Date(
      new Date("2026-01-01T00:00:00.000Z").getTime() + 48 * 60 * 60 * 1000,
    );
    const result = canResolve(p2, "auto-timeout", null, at48h);
    expect(result.ok).toBe(false);
  });

  it("does not apply to an access-identity P3 ticket even when allowlisted", () => {
    const accessIdentity = baseTicket({
      remediation: {
        action: "access-reset-idp-up",
        runId: "run_1" as never,
        appliedAt: "2026-01-01T00:10:00.000Z",
      },
      triage: {
        ...(lowRiskTicket.triage as NonNullable<Ticket["triage"]>),
        category: "access-identity",
        subcategory: "account-locked",
      },
    });
    const at48h = new Date(
      new Date("2026-01-01T00:00:00.000Z").getTime() + 48 * 60 * 60 * 1000,
    );
    const result = canResolve(accessIdentity, "auto-timeout", null, at48h);
    expect(result.ok).toBe(false);
  });
});

describe("canResolve — human-agent", () => {
  it("succeeds only when the ticket is in Escalated", () => {
    const escalated = baseTicket({ state: "Escalated" });
    const result = canResolve(escalated, "human-agent", null, new Date());
    expect(result.ok).toBe(true);
  });

  it("rejects when the ticket is not in Escalated", () => {
    const pending = baseTicket({ state: "PendingUserConfirmation" });
    const result = canResolve(pending, "human-agent", null, new Date());
    expect(result.ok).toBe(false);
  });
});
