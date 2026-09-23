import { describe, expect, it } from "vitest";
import { canReopen } from "./reopen-policy.js";
import type { Ticket } from "./ticket.js";

function resolvedTicket(resolvedAt: string): Ticket {
  return {
    id: "tkt_1" as Ticket["id"],
    version: 5,
    state: "Resolved",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: resolvedAt,
    description: "vpn is down" as Ticket["description"],
    diagnostics: [],
    systemState: { accountUnlockSimulated: false, resetLinkIssued: false },
    history: [],
    resolution: { basis: "user-confirmed", resolvedAt },
  };
}

const RESOLVED_AT = "2026-01-01T00:00:00.000Z";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

describe("canReopen", () => {
  it("succeeds within the 7-day window", () => {
    const ticket = resolvedTicket(RESOLVED_AT);
    const threeDaysLater = new Date(
      new Date(RESOLVED_AT).getTime() + 3 * 24 * 60 * 60 * 1000,
    );
    expect(canReopen(ticket, threeDaysLater).ok).toBe(true);
  });

  it("succeeds exactly at the 168-hour boundary (inclusive)", () => {
    const ticket = resolvedTicket(RESOLVED_AT);
    const atBoundary = new Date(new Date(RESOLVED_AT).getTime() + SEVEN_DAYS_MS);
    expect(canReopen(ticket, atBoundary).ok).toBe(true);
  });

  it("fails at 168 hours + 1ms with REOPEN_WINDOW_EXPIRED and a create_ticket suggestion", () => {
    const ticket = resolvedTicket(RESOLVED_AT);
    const justAfter = new Date(
      new Date(RESOLVED_AT).getTime() + SEVEN_DAYS_MS + 1,
    );
    const result = canReopen(ticket, justAfter);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REOPEN_WINDOW_EXPIRED");
      expect(result.error.details?.suggestion).toContain("create_ticket");
    }
  });

  it("fails when the ticket was never resolved", () => {
    const ticket = resolvedTicket(RESOLVED_AT);
    const { resolution: _omit, ...withoutResolution } = ticket;
    const result = canReopen(withoutResolution as Ticket, new Date());
    expect(result.ok).toBe(false);
  });
});
