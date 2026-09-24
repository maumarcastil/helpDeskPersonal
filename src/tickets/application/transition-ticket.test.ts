import { describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "../../audit/domain/audit-entry.js";
import type { AuditLog } from "../../audit/ports/audit-log.js";
import type { Pseudonym } from "../../redaction/domain/pseudonymize.js";
import type { Pseudonymizer } from "../../redaction/ports/pseudonymizer.js";
import type { AuditId, RunId, TicketId } from "../../shared/domain/ids.js";
import type { Clock } from "../../shared/ports/clock.js";
import type { IdGenerator } from "../../shared/ports/id-generator.js";
import type { TicketListFilter, TicketRepository } from "../ports/ticket-repository.js";
import type { Ticket } from "../domain/ticket.js";
import * as transitionsModule from "../domain/transitions.js";
import { transitionTicket } from "./transition-ticket.js";

const FIXED_NOW = new Date("2026-01-05T00:00:00.000Z");
const fixedClock: Clock = { now: () => FIXED_NOW };

class InMemoryTicketRepository implements TicketRepository {
  private readonly store = new Map<string, { ticket: Ticket; version: number }>();

  seed(ticket: Ticket, storedVersion = ticket.version): void {
    this.store.set(ticket.id, { ticket, version: storedVersion });
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

  async append(entry: Omit<AuditEntry, "seq" | "prevHash" | "hash">) {
    this.seq += 1;
    this.entries.push({ ...entry, seq: this.seq, prevHash: "genesis", hash: `hash_${this.seq}` });
    return entry.id;
  }

  async listByTicket(ticketId: TicketId): Promise<readonly AuditEntry[]> {
    return this.entries.filter((e) => e.ticketId === ticketId);
  }
}

/** Counting fake `IdGenerator` — `auditId()` calls are asserted on directly
 * in the "mints exactly one audit id" test below. */
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

/** Deterministic, key-sensitive fake digest — not real HMAC, just enough to
 * keep the `usr_<16 hex>` shape and let key/raw sensitivity be asserted. */
function fakeDigest16(key: string, raw: string): string {
  let h = 0;
  for (const ch of `${key}\u0000${raw}`) {
    h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return h.toString(16).padStart(16, "0").slice(0, 16);
}

/** Fake `Pseudonymizer` — deterministic, no real HMAC needed for these tests. */
class FakePseudonymizer implements Pseudonymizer {
  constructor(private readonly key: string) {}
  pseudonymize(raw: string): Pseudonym {
    const digest = fakeDigest16(this.key, raw);
    return { ref: `usr_${digest}`, display: `User ${digest.slice(0, 6)}` };
  }
}

function ports(pseudonymKey = "test-key") {
  return {
    ticketRepository: new InMemoryTicketRepository(),
    auditLog: new InMemoryAuditLog(),
    clock: fixedClock,
    idGenerator: new InMemoryIdGenerator(),
    pseudonymizer: new FakePseudonymizer(pseudonymKey),
  };
}

function newTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "tkt_1" as TicketId,
    version: 1,
    state: "New",
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    description: "vpn is down" as Ticket["description"],
    diagnostics: [],
    systemState: { accountUnlockSimulated: false, resetLinkIssued: false },
    history: [],
    ...overrides,
  };
}

describe("transitionTicket — success path", () => {
  it("loads, applies, persists, and appends a ticket.transitioned audit entry", async () => {
    const p = ports();
    const ticket = newTicket();
    p.ticketRepository.seed(ticket);

    const result = await transitionTicket(p, {
      ticketId: ticket.id,
      actor: "triage",
      to: "Triaged",
      payload: {
        category: "infrastructure-software",
        subcategory: "vpn",
        severity: "medium",
        urgency: "medium",
        affectedUser: "jane.doe@example.com",
        impactedService: "corp-vpn",
        summary: "vpn gateway unreachable",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ticket.state).toBe("Triaged");
    expect(result.value.ticket.version).toBe(2);

    const stored = await p.ticketRepository.getById(ticket.id);
    expect(stored?.state).toBe("Triaged");

    const successEntries = p.auditLog.entries.filter((e) => e.type === "ticket.transitioned");
    expect(successEntries).toHaveLength(1);
    expect(stored?.history[0]?.auditRef).toBe(successEntries[0]?.id);
  });

  it("pseudonymizes affectedUser instead of storing the raw value", async () => {
    const p = ports();
    const ticket = newTicket();
    p.ticketRepository.seed(ticket);

    const result = await transitionTicket(p, {
      ticketId: ticket.id,
      actor: "triage",
      to: "Triaged",
      payload: {
        category: "infrastructure-software",
        subcategory: "vpn",
        severity: "medium",
        urgency: "medium",
        affectedUser: "jane.doe@example.com",
        impactedService: "corp-vpn",
        summary: "vpn gateway unreachable",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ticket.triage?.affectedUser.ref).toMatch(/^usr_[0-9a-f]{16}$/);
    expect(result.value.ticket.triage?.affectedUser.display).not.toBe("jane.doe@example.com");
  });

  it("calls the pure applyTransition exactly once for a successful transition (no dry-run pass)", async () => {
    const spy = vi.spyOn(transitionsModule, "applyTransition");
    try {
      const p = ports();
      const ticket = newTicket();
      p.ticketRepository.seed(ticket);

      const result = await transitionTicket(p, {
        ticketId: ticket.id,
        actor: "triage",
        to: "Triaged",
        payload: {
          category: "infrastructure-software",
          subcategory: "vpn",
          severity: "medium",
          urgency: "medium",
          affectedUser: "jane.doe@example.com",
          impactedService: "corp-vpn",
          summary: "vpn gateway unreachable",
        },
      });

      expect(result.ok).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("mints exactly one audit id per successful transition, used as both history.auditRef and the appended entry's id", async () => {
    const p = ports();
    const auditIdSpy = vi.spyOn(p.idGenerator, "auditId");
    const ticket = newTicket();
    p.ticketRepository.seed(ticket);

    const result = await transitionTicket(p, {
      ticketId: ticket.id,
      actor: "triage",
      to: "Triaged",
      payload: {
        category: "infrastructure-software",
        subcategory: "vpn",
        severity: "medium",
        urgency: "medium",
        affectedUser: "jane.doe@example.com",
        impactedService: "corp-vpn",
        summary: "vpn gateway unreachable",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(auditIdSpy).toHaveBeenCalledTimes(1);

    const stored = await p.ticketRepository.getById(ticket.id);
    expect(stored?.history[0]?.auditRef).toBe(result.value.auditRef);
    expect(p.auditLog.entries).toHaveLength(1);
    expect(p.auditLog.entries[0]?.id).toBe(result.value.auditRef);
  });
});

describe("transitionTicket — rejection path", () => {
  it("appends a transition.rejected audit entry and leaves the ticket unchanged when the actor is not permitted", async () => {
    const p = ports();
    const ticket = newTicket();
    p.ticketRepository.seed(ticket);

    const result = await transitionTicket(p, {
      ticketId: ticket.id,
      actor: "diagnostic",
      to: "Triaged",
      payload: {
        category: "infrastructure-software",
        subcategory: "vpn",
        severity: "medium",
        urgency: "medium",
        affectedUser: "jane.doe@example.com",
        impactedService: "corp-vpn",
        summary: "vpn gateway unreachable",
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ACTOR_NOT_PERMITTED");

    const stored = await p.ticketRepository.getById(ticket.id);
    expect(stored?.state).toBe("New");
    expect(stored?.version).toBe(1);

    const rejectedEntries = p.auditLog.entries.filter((e) => e.type === "transition.rejected");
    expect(rejectedEntries).toHaveLength(1);
  });
});

describe("transitionTicket — Escalated (server-generated decisionLogRef)", () => {
  it("creates the audit entry first and sets escalation.decisionLogRef to that entry's id", async () => {
    const p = ports();
    const ticket = newTicket({ state: "InProgress", version: 3 });
    p.ticketRepository.seed(ticket);

    const result = await transitionTicket(p, {
      ticketId: ticket.id,
      actor: "diagnostic",
      to: "Escalated",
      payload: {
        escalationReason: "no_diagnostic_available",
        target: "network-team",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ticket.escalation?.decisionLogRef).toBe(result.value.auditRef);

    const successEntries = p.auditLog.entries.filter((e) => e.type === "ticket.transitioned");
    expect(successEntries).toHaveLength(1);
    expect(successEntries[0]?.id).toBe(result.value.auditRef);
  });
});

describe("transitionTicket — optimistic concurrency", () => {
  it("returns CONFLICT and does not append a ticket.transitioned success entry when a concurrent writer already moved the version", async () => {
    const auditLog = new InMemoryAuditLog();
    const staleSnapshot = newTicket({ state: "Triaged", version: 2 });
    const trueTicket = newTicket({ state: "Triaged", version: 3 });

    let getByIdCalls = 0;
    const repository: TicketRepository = {
      getById: async () => {
        getByIdCalls += 1;
        // First read (the use case's initial load) returns a stale
        // snapshot; every subsequent read reflects that a concurrent
        // writer already saved a newer version in between.
        return getByIdCalls === 1 ? staleSnapshot : trueTicket;
      },
      save: async (_ticket, expectedVersion) => {
        if (expectedVersion !== trueTicket.version) {
          return {
            ok: false as const,
            error: { code: "CONFLICT" as const, message: "version mismatch" },
          };
        }
        return { ok: true as const, value: undefined };
      },
      list: async () => [trueTicket],
    };

    const result = await transitionTicket(
      {
        ticketRepository: repository,
        auditLog,
        clock: fixedClock,
        idGenerator: new InMemoryIdGenerator(),
        pseudonymizer: new FakePseudonymizer("k"),
      },
      { ticketId: staleSnapshot.id, actor: "diagnostic", to: "InProgress", payload: {} },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFLICT");

    const successEntries = auditLog.entries.filter((e) => e.type === "ticket.transitioned");
    expect(successEntries).toHaveLength(0);
    const rejectedEntries = auditLog.entries.filter((e) => e.type === "transition.rejected");
    expect(rejectedEntries).toHaveLength(1);
  });
});

describe("transitionTicket — InProgress -> PendingUserConfirmation guard (completed run referenced)", () => {
  it("rejects with DIAGNOSTIC_NOT_USABLE when the referenced runId is not on the ticket", async () => {
    const p = ports();
    const ticket = newTicket({ state: "InProgress", version: 2 });
    p.ticketRepository.seed(ticket);

    const result = await transitionTicket(p, {
      ticketId: ticket.id,
      actor: "diagnostic",
      to: "PendingUserConfirmation",
      payload: {
        diagnosticEvidence: { runId: "run_missing" },
        remediationAction: null,
        timestamp: FIXED_NOW.toISOString(),
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DIAGNOSTIC_NOT_USABLE");

    const rejectedEntries = p.auditLog.entries.filter((e) => e.type === "transition.rejected");
    expect(rejectedEntries).toHaveLength(1);
  });

  it("rejects with DIAGNOSTIC_NOT_USABLE when the referenced run exists but did not complete", async () => {
    const p = ports();
    const ticket = newTicket({
      state: "InProgress",
      version: 2,
      diagnostics: [
        {
          runId: "run_1" as RunId,
          at: FIXED_NOW.toISOString(),
          outcome: { kind: "failed", reason: "timeout", durationMs: 5000 },
          decision: { kind: "escalate", reason: "diagnostic_failed" },
        },
      ],
    });
    p.ticketRepository.seed(ticket);

    const result = await transitionTicket(p, {
      ticketId: ticket.id,
      actor: "diagnostic",
      to: "PendingUserConfirmation",
      payload: {
        diagnosticEvidence: { runId: "run_1" },
        remediationAction: null,
        timestamp: FIXED_NOW.toISOString(),
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DIAGNOSTIC_NOT_USABLE");
  });

  it("succeeds when the referenced run exists and completed", async () => {
    const p = ports();
    const ticket = newTicket({
      state: "InProgress",
      version: 2,
      diagnostics: [
        {
          runId: "run_1" as RunId,
          at: FIXED_NOW.toISOString(),
          outcome: {
            kind: "completed",
            durationMs: 500,
            report: {
              schemaVersion: 1,
              probe: "connectivity",
              mode: "mock",
              target: "tcp://vpn.internal.example.com:443",
              status: "reachable",
              checks: [{ name: "tcp", ok: true, latencyMs: 10 }],
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
    p.ticketRepository.seed(ticket);

    const result = await transitionTicket(p, {
      ticketId: ticket.id,
      actor: "diagnostic",
      to: "PendingUserConfirmation",
      payload: {
        diagnosticEvidence: { runId: "run_1" },
        remediationAction: null,
        timestamp: FIXED_NOW.toISOString(),
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ticket.state).toBe("PendingUserConfirmation");
  });
});
