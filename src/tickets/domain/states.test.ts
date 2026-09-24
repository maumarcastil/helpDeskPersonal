import { describe, expect, it } from "vitest";
import { STATE_RANK, type TicketState } from "./states.js";

describe("STATE_RANK", () => {
  it("is monotonic along the main forward path", () => {
    const mainPath: readonly TicketState[] = [
      "New",
      "Triaged",
      "InProgress",
      "PendingUserConfirmation",
      "Escalated",
      "Resolved",
      "Closed",
    ];

    for (let i = 1; i < mainPath.length; i += 1) {
      const prev = mainPath[i - 1] as TicketState;
      const curr = mainPath[i] as TicketState;
      expect(STATE_RANK[curr]).toBeGreaterThan(STATE_RANK[prev]);
    }
  });

  it("gives Triaged and Reopened the same rank", () => {
    expect(STATE_RANK.Triaged).toBe(STATE_RANK.Reopened);
  });

  it("defines all 8 states", () => {
    const states: readonly TicketState[] = [
      "New",
      "Triaged",
      "InProgress",
      "PendingUserConfirmation",
      "Escalated",
      "Resolved",
      "Closed",
      "Reopened",
    ];
    for (const state of states) {
      expect(typeof STATE_RANK[state]).toBe("number");
    }
  });
});
