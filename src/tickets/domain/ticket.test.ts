import { describe, expect, it } from "vitest";
import type { TicketId } from "../../shared/domain/ids.js";
import { createNewTicket } from "./ticket.js";

const fixedNow = new Date("2026-01-01T00:00:00.000Z");
const fixedTicketId = "tkt_fixed" as TicketId;

describe("createNewTicket", () => {
  it("returns a New ticket at version 1 with empty history and default systemState", () => {
    const ticket = createNewTicket("printer is broken", fixedTicketId, fixedNow);

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
