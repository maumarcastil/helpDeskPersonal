import { describe, expect, it } from "vitest";
import type { AuditEntry } from "../../audit/domain/audit-entry.js";
import type { AuditLog } from "../../audit/ports/audit-log.js";
import type { AuditId, RunId, TicketId } from "../../shared/domain/ids.js";
import type { Clock } from "../../shared/ports/clock.js";
import type { IdGenerator } from "../../shared/ports/id-generator.js";
import type { TicketListFilter, TicketRepository } from "../ports/ticket-repository.js";
import type { Ticket } from "../domain/ticket.js";
import { createTicket } from "./create-ticket.js";

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");
const fixedClock: Clock = { now: () => FIXED_NOW };

function fixedIdGenerator(ticketId: string): IdGenerator {
  return {
    ticketId: () => ticketId as TicketId,
    runId: () => "run_unused" as RunId,
    auditId: () => "aud_unused" as AuditId,
  };
}

class InMemoryTicketRepository implements TicketRepository {
  private readonly store = new Map<string, { ticket: Ticket; version: number }>();

  seed(ticket: Ticket): void {
    this.store.set(ticket.id, { ticket, version: ticket.version });
  }

  async getById(id: TicketId): Promise<Ticket | null> {
    return this.store.get(id)?.ticket ?? null;
  }

  async save(ticket: Ticket, expectedVersion: number) {
    const existing = this.store.get(ticket.id);
    const currentVersion = existing?.version ?? 0;
    if (currentVersion !== expectedVersion) {
      return {
        ok: false as const,
        error: { code: "CONFLICT" as const, message: "version mismatch" },
      };
    }
    this.store.set(ticket.id, { ticket, version: ticket.version });
    return { ok: true as const, value: undefined };
  }

  async list(_filter: TicketListFilter): Promise<readonly Ticket[]> {
    return [...this.store.values()].map((entry) => entry.ticket);
  }
}

class InMemoryAuditLog implements AuditLog {
  private seq = 0;
  readonly entries: AuditEntry[] = [];

  async append(entry: Omit<AuditEntry, "seq" | "prevHash" | "hash">): Promise<AuditId> {
    this.seq += 1;
    this.entries.push({ ...entry, seq: this.seq, prevHash: "genesis", hash: `hash_${this.seq}` });
    return entry.id;
  }

  async listByTicket(ticketId: TicketId): Promise<readonly AuditEntry[]> {
    return this.entries.filter((e) => e.ticketId === ticketId);
  }
}

function ports() {
  const ticketRepository = new InMemoryTicketRepository();
  const auditLog = new InMemoryAuditLog();
  return {
    ticketRepository,
    auditLog,
    clock: fixedClock,
    idGenerator: fixedIdGenerator("tkt_new"),
  };
}

describe("createTicket", () => {
  it("creates a ticket in New state and returns its id, with text redacted", async () => {
    const p = ports();
    const result = await createTicket(p, { text: "printer is broken" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ticket.state).toBe("New");
    expect(result.value.ticket.id).toBe("tkt_new");

    const stored = await p.ticketRepository.getById("tkt_new" as TicketId);
    expect(stored?.state).toBe("New");
  });

  it("redacts a password/token in the free text before persisting", async () => {
    const p = ports();
    const result = await createTicket(p, {
      text: "vpn broken, my password is Hunter2024!",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ticket.description).toContain("[REDACTED:SECRET_ASSIGNMENT]");
    expect(result.value.ticket.description).not.toContain("Hunter2024!");
  });

  it("rejects a relatedTicketId that does not exist in the repository", async () => {
    const p = ports();
    const result = await createTicket(p, {
      text: "follow-up issue",
      relatedTicketId: "tkt_missing" as TicketId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TICKET_NOT_FOUND");
  });

  it("accepts a relatedTicketId that exists in the repository", async () => {
    const p = ports();
    p.ticketRepository.seed({
      id: "tkt_original" as TicketId,
      version: 1,
      state: "New",
      createdAt: FIXED_NOW.toISOString(),
      updatedAt: FIXED_NOW.toISOString(),
      description: "original" as Ticket["description"],
      diagnostics: [],
      systemState: { accountUnlockSimulated: false, resetLinkIssued: false },
      history: [],
    });
    const result = await createTicket(p, {
      text: "follow-up issue",
      relatedTicketId: "tkt_original" as TicketId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ticket.relatedTicketId).toBe("tkt_original");
  });

  it("appends a ticket.created audit entry including redaction findings (kind + count, never the value)", async () => {
    const p = ports();
    await createTicket(p, { text: "my password is Hunter2024!" });
    expect(p.auditLog.entries).toHaveLength(1);
    const entry = p.auditLog.entries[0];
    expect(entry?.type).toBe("ticket.created");
    expect(entry?.redactionFindings).toEqual([{ kind: "SECRET_ASSIGNMENT", count: 1 }]);
    expect(JSON.stringify(entry)).not.toContain("Hunter2024!");
  });

  it("appends a ticket.created audit entry with no redactionFindings when nothing matched", async () => {
    const p = ports();
    await createTicket(p, { text: "printer is broken" });
    const entry = p.auditLog.entries[0];
    expect(entry?.redactionFindings).toBeUndefined();
  });
});
