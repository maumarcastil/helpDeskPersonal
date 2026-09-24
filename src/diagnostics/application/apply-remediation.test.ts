import { describe, expect, it } from "vitest";
import type { AuditEntry } from "../../audit/domain/audit-entry.js";
import type { AuditLog } from "../../audit/ports/audit-log.js";
import type { AuditId, RunId, TicketId } from "../../shared/domain/ids.js";
import type { Clock } from "../../shared/ports/clock.js";
import type { IdGenerator } from "../../shared/ports/id-generator.js";
import type { TicketListFilter, TicketRepository } from "../../tickets/ports/ticket-repository.js";
import type { Ticket } from "../../tickets/domain/ticket.js";
import { applyRemediation } from "./apply-remediation.js";

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");
const fixedClock: Clock = { now: () => FIXED_NOW };

class InMemoryAuditLog implements AuditLog {
  private seq = 0;
  readonly entries: AuditEntry[] = [];
  async append(entry: Omit<AuditEntry, "seq" | "prevHash" | "hash">) {
    this.seq += 1;
    this.entries.push({ ...entry, seq: this.seq, prevHash: "genesis", hash: `hash_${this.seq}` });
    return entry.id;
  }
  async listByTicket(ticketId: TicketId): Promise<readonly AuditEntry[]> {
    return this.entries.filter((e) => e.ticketId === ticketId);
  }
}

class InMemoryIdGenerator implements IdGenerator {
  private n = 0;
  ticketId(): TicketId {
    this.n += 1;
    return `tkt_gen_${this.n}` as TicketId;
  }
  runId(): RunId {
    this.n += 1;
    return `run_gen_${this.n}` as RunId;
  }
  auditId(): AuditId {
    this.n += 1;
    return `aud_gen_${this.n}` as AuditId;
  }
}

function repoWith(ticket: Ticket): TicketRepository & { saved: Ticket[] } {
  const saved: Ticket[] = [];
  return {
    saved,
    getById: async () => ticket,
    save: async (t: Ticket) => {
      saved.push(t);
      return { ok: true as const, value: undefined };
    },
    list: async (_filter: TicketListFilter) => [ticket],
  };
}

function baseTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "tkt_1" as TicketId,
    version: 3,
    state: "InProgress",
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    description: "vpn down" as Ticket["description"],
    diagnostics: [],
    systemState: { accountUnlockSimulated: false, resetLinkIssued: false },
    history: [],
    ...overrides,
  };
}

function ports(ticket: Ticket) {
  return {
    ticketRepository: repoWith(ticket),
    auditLog: new InMemoryAuditLog(),
    clock: fixedClock,
    idGenerator: new InMemoryIdGenerator(),
  };
}

describe("applyRemediation — validation", () => {
  it("rejects when the ticket is not InProgress", async () => {
    const ticket = baseTicket({ state: "Triaged" });
    const p = ports(ticket);
    const result = await applyRemediation(p, {
      ticketId: ticket.id,
      actor: "diagnostic",
      runId: "run_1" as RunId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DIAGNOSTIC_NOT_USABLE");
  });

  it("rejects with DIAGNOSTIC_NOT_USABLE when the referenced run does not exist on the ticket", async () => {
    const ticket = baseTicket();
    const p = ports(ticket);
    const result = await applyRemediation(p, {
      ticketId: ticket.id,
      actor: "diagnostic",
      runId: "run_missing" as RunId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DIAGNOSTIC_NOT_USABLE");
  });

  it("rejects with NOT_ALLOWLISTED when the referenced run's decision is escalate, not remediate", async () => {
    const ticket = baseTicket({
      diagnostics: [
        {
          runId: "run_1" as RunId,
          at: FIXED_NOW.toISOString(),
          outcome: { kind: "failed", reason: "timeout", durationMs: 1 },
          decision: { kind: "escalate", reason: "diagnostic_failed" },
        },
      ],
    });
    const p = ports(ticket);
    const result = await applyRemediation(p, {
      ticketId: ticket.id,
      actor: "diagnostic",
      runId: "run_1" as RunId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_ALLOWLISTED");
  });
});

describe("applyRemediation — success", () => {
  function ticketWithRemediateDecision(): Ticket {
    return baseTicket({
      diagnostics: [
        {
          runId: "run_1" as RunId,
          at: FIXED_NOW.toISOString(),
          outcome: {
            kind: "completed",
            durationMs: 1,
            report: {
              schemaVersion: 1,
              probe: "connectivity",
              mode: "mock",
              target: "tcp://vpn.internal.example.com:443",
              status: "reachable",
              checks: [{ name: "tcp", ok: true, latencyMs: 1 }],
              startedAt: FIXED_NOW.toISOString(),
              finishedAt: FIXED_NOW.toISOString(),
            },
          },
          decision: {
            kind: "remediate",
            entryId: "vpn-gateway-up",
            action: "record-service-healthy",
          },
        },
      ],
    });
  }

  it("applies the entry's effect to systemState and transitions to PendingUserConfirmation", async () => {
    const ticket = ticketWithRemediateDecision();
    const p = ports(ticket);
    const result = await applyRemediation(p, {
      ticketId: ticket.id,
      actor: "diagnostic",
      runId: "run_1" as RunId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ticket.state).toBe("PendingUserConfirmation");
    expect(result.value.ticket.pendingSince).toBe(FIXED_NOW.toISOString());
    expect(result.value.ticket.systemState.serviceVerifiedHealthyAt).toBe(
      FIXED_NOW.toISOString(),
    );
    expect(result.value.action).toBe("record-service-healthy");
    expect(p.ticketRepository.saved[0]?.state).toBe("PendingUserConfirmation");
  });

  it("appends a remediation.applied audit entry", async () => {
    const ticket = ticketWithRemediateDecision();
    const p = ports(ticket);
    await applyRemediation(p, {
      ticketId: ticket.id,
      actor: "diagnostic",
      runId: "run_1" as RunId,
    });
    expect(p.auditLog.entries.map((e) => e.type)).toEqual(["remediation.applied"]);
  });

  it("returns the appended audit entry's id as auditRef (design: apply_remediation output includes auditRef)", async () => {
    const ticket = ticketWithRemediateDecision();
    const p = ports(ticket);
    const result = await applyRemediation(p, {
      ticketId: ticket.id,
      actor: "diagnostic",
      runId: "run_1" as RunId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.auditRef).toBe(p.auditLog.entries[0]?.id);
  });
});
