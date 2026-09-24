import { describe, expect, it } from "vitest";
import type { TicketId } from "../../shared/domain/ids.js";
import type { TicketListFilter, TicketRepository } from "../ports/ticket-repository.js";
import type { Ticket } from "../domain/ticket.js";
import { listTickets } from "./list-tickets.js";

function ticket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: id as TicketId,
    version: 1,
    state: "New",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    description: "x" as Ticket["description"],
    diagnostics: [],
    systemState: { accountUnlockSimulated: false, resetLinkIssued: false },
    history: [],
    ...overrides,
  };
}

function repoWith(tickets: readonly Ticket[]): TicketRepository {
  return {
    getById: async (id) => tickets.find((t) => t.id === id) ?? null,
    save: async () => ({ ok: true as const, value: undefined }),
    list: async (filter: TicketListFilter) => {
      let result = tickets;
      if (filter.state) result = result.filter((t) => t.state === filter.state);
      if (filter.category) {
        result = result.filter((t) => t.triage?.category === filter.category);
      }
      if (filter.priority) {
        result = result.filter((t) => t.triage?.priority === filter.priority);
      }
      const limit = filter.limit ?? 50;
      return result.slice(0, limit);
    },
  };
}

describe("listTickets", () => {
  it("passes state/category/priority filters through to the repository", async () => {
    const tickets = [
      ticket("tkt_1", { state: "New" }),
      ticket("tkt_2", {
        state: "Triaged",
        triage: {
          category: "infrastructure-software",
          subcategory: "vpn",
          severity: "medium",
          urgency: "medium",
          priority: "P2",
          sla: { responseDueAt: "x", resolutionDueAt: "y" },
          affectedUser: { ref: "usr_1", display: "User 1" },
          impactedService: "corp-vpn",
        },
      }),
    ];
    const result = await listTickets(
      { ticketRepository: repoWith(tickets) },
      { state: "Triaged", category: "infrastructure-software", priority: "P2" },
    );
    expect(result.tickets.map((t) => t.id)).toEqual(["tkt_2"]);
  });

  it("caps the limit at 50 even if a larger value is requested", async () => {
    const tickets = Array.from({ length: 60 }, (_, i) => ticket(`tkt_${i}`));
    let capturedLimit: number | undefined;
    const repository: TicketRepository = {
      getById: async () => null,
      save: async () => ({ ok: true as const, value: undefined }),
      list: async (filter: TicketListFilter) => {
        capturedLimit = filter.limit;
        return tickets.slice(0, filter.limit ?? tickets.length);
      },
    };
    const result = await listTickets({ ticketRepository: repository }, { limit: 500 });
    expect(capturedLimit).toBe(50);
    expect(result.tickets.length).toBeLessThanOrEqual(50);
  });

  it("defaults to a limit of 50 when none is requested", async () => {
    let capturedLimit: number | undefined;
    const repository: TicketRepository = {
      getById: async () => null,
      save: async () => ({ ok: true as const, value: undefined }),
      list: async (filter: TicketListFilter) => {
        capturedLimit = filter.limit;
        return [];
      },
    };
    await listTickets({ ticketRepository: repository }, {});
    expect(capturedLimit).toBe(50);
  });
});
