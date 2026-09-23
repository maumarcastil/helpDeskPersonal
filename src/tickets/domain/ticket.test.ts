import { describe, expect, it } from "vitest";
import type { Clock } from "../../shared/clock.js";
import type { IdGenerator } from "../../shared/id-generator.js";
import { createNewTicket } from "./ticket.js";

const fixedClock: Clock = {
  now: () => new Date("2026-01-01T00:00:00.000Z"),
};

const fakeIdGenerator: IdGenerator = {
  ticketId: () => "tkt_fixed" as ReturnType<IdGenerator["ticketId"]>,
  runId: () => "run_fixed" as ReturnType<IdGenerator["runId"]>,
  auditId: () => "aud_fixed" as ReturnType<IdGenerator["auditId"]>,
};

describe("createNewTicket", () => {
  it("returns a New ticket at version 1 with empty history and default systemState", () => {
    const ticket = createNewTicket(
      "printer is broken",
      fixedClock,
      fakeIdGenerator,
    );

    expect(ticket.state).toBe("New");
    expect(ticket.version).toBe(1);
    expect(ticket.history).toEqual([]);
    expect(ticket.systemState).toEqual({
      accountUnlockSimulated: false,
      resetLinkIssued: false,
    });
    expect(ticket.description).toBe("printer is broken");
    expect(ticket.id).toBe("tkt_fixed");
    expect(ticket.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(ticket.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
