import { describe, expect, it } from "vitest";
import type { TicketId } from "../../shared/domain/ids.js";
import type { TicketListFilter, TicketRepository } from "../ports/ticket-repository.js";
import type { Ticket } from "../domain/ticket.js";
import { getTicket } from "./get-ticket.js";

function repoWith(ticket: Ticket | null): TicketRepository {
  return {
    getById: async () => ticket,
    save: async () => ({ ok: true as const, value: undefined }),
    list: async (_filter: TicketListFilter) => (ticket ? [ticket] : []),
  };
}

const existingTicket: Ticket = {
  id: "tkt_1" as TicketId,
  version: 1,
  state: "New",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  description: "printer broken" as Ticket["description"],
  diagnostics: [],
  systemState: { accountUnlockSimulated: false, resetLinkIssued: false },
  history: [],
};

describe("getTicket", () => {
  it("returns the ticket when found", async () => {
    const result = await getTicket(
      { ticketRepository: repoWith(existingTicket) },
      { ticketId: "tkt_1" as TicketId },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ticket.id).toBe("tkt_1");
  });

  it("returns TICKET_NOT_FOUND for a missing id", async () => {
    const result = await getTicket(
      { ticketRepository: repoWith(null) },
      { ticketId: "tkt_missing" as TicketId },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TICKET_NOT_FOUND");
  });
});
