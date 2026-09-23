import { describe, expect, it } from "vitest";
import type { AuditEntry } from "../../audit/domain/audit-entry.js";
import type { AuditLog } from "../../audit/ports/audit-log.js";
import type { AuditId, RunId, TicketId } from "../../shared/domain/ids.js";
import type { Clock } from "../../shared/ports/clock.js";
import type { IdGenerator } from "../../shared/ports/id-generator.js";
import type { TicketListFilter, TicketRepository } from "../../tickets/ports/ticket-repository.js";
import type { Ticket } from "../../tickets/domain/ticket.js";
import type { DiagnosticRunner } from "../ports/diagnostic-runner.js";
import type { ServiceCatalog } from "../ports/service-catalog.js";
import type { RunnerOutcome } from "../domain/runner-outcome.js";
import { runDiagnostic } from "./run-diagnostic.js";

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");
const fixedClock: Clock = { now: () => FIXED_NOW };
const fixedIdGenerator: IdGenerator = {
  ticketId: () => "tkt_unused" as TicketId,
  runId: () => "run_new" as RunId,
  auditId: () => "aud_unused" as AuditId,
};

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
    version: 2,
    state: "InProgress",
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    description: "vpn down" as Ticket["description"],
    diagnostics: [],
    systemState: { accountUnlockSimulated: false, resetLinkIssued: false },
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
    history: [],
    ...overrides,
  };
}

function catalogResolving(target: { kind: "tcp"; host: string; port: number } | null): ServiceCatalog {
  return { resolve: () => target, list: () => ["corp-vpn"] };
}

function runnerReturning(outcome: RunnerOutcome): DiagnosticRunner {
  return { run: async () => outcome };
}

function ports(
  ticket: Ticket,
  catalog: ServiceCatalog,
  runner: DiagnosticRunner,
) {
  return {
    ticketRepository: repoWith(ticket),
    serviceCatalog: catalog,
    diagnosticRunner: runner,
    auditLog: new InMemoryAuditLog(),
    clock: fixedClock,
    idGenerator: fixedIdGenerator,
  };
}

describe("runDiagnostic — preconditions", () => {
  it("rejects when the ticket is not InProgress or PendingUserConfirmation", async () => {
    const ticket = baseTicket({ state: "Triaged" });
    const p = ports(ticket, catalogResolving({ kind: "tcp", host: "vpn", port: 443 }), runnerReturning({ kind: "completed", durationMs: 1, report: mockReport("reachable") }));
    const result = await runDiagnostic(p, { ticketId: ticket.id, actor: "diagnostic" });
    expect(result.ok).toBe(false);
  });

  it("rejects when the actor is not diagnostic", async () => {
    const ticket = baseTicket();
    const p = ports(ticket, catalogResolving({ kind: "tcp", host: "vpn", port: 443 }), runnerReturning({ kind: "completed", durationMs: 1, report: mockReport("reachable") }));
    const result = await runDiagnostic(p, { ticketId: ticket.id, actor: "escalation" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ACTOR_NOT_PERMITTED");
  });
});

describe("runDiagnostic — unknown service", () => {
  it("escalates with no_diagnostic_available without invoking the runner", async () => {
    let runnerInvoked = false;
    const ticket = baseTicket();
    const runner: DiagnosticRunner = {
      run: async () => {
        runnerInvoked = true;
        return { kind: "completed", durationMs: 1, report: mockReport("reachable") };
      },
    };
    const p = ports(ticket, catalogResolving(null), runner);
    const result = await runDiagnostic(p, { ticketId: ticket.id, actor: "diagnostic" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toEqual({ kind: "escalate", reason: "no_diagnostic_available" });
    expect(runnerInvoked).toBe(false);
    expect(p.auditLog.entries).toHaveLength(1);
  });
});

describe("runDiagnostic — successful run", () => {
  it("feeds a completed outcome through decideRemediation and stores the DiagnosticRun on the ticket", async () => {
    const ticket = baseTicket();
    const p = ports(
      ticket,
      catalogResolving({ kind: "tcp", host: "vpn.internal.example.com", port: 443 }),
      runnerReturning({ kind: "completed", durationMs: 42, report: mockReport("reachable") }),
    );
    const result = await runDiagnostic(p, { ticketId: ticket.id, actor: "diagnostic" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toEqual({
      kind: "remediate",
      entryId: "vpn-gateway-up",
      action: "record-service-healthy",
    });
    expect(result.value.outcome).toBe("completed");

    expect(p.ticketRepository.saved).toHaveLength(1);
    const saved = p.ticketRepository.saved[0];
    expect(saved?.diagnostics).toHaveLength(1);
    expect(saved?.diagnostics[0]?.runId).toBe("run_new");
    expect(saved?.state).toBe("InProgress");
  });

  it("never mutates ticket.state", async () => {
    const ticket = baseTicket({ state: "PendingUserConfirmation" });
    const p = ports(
      ticket,
      catalogResolving({ kind: "tcp", host: "vpn", port: 443 }),
      runnerReturning({ kind: "completed", durationMs: 1, report: mockReport("reachable") }),
    );
    await runDiagnostic(p, { ticketId: ticket.id, actor: "diagnostic" });
    expect(p.ticketRepository.saved[0]?.state).toBe("PendingUserConfirmation");
  });

  it("bounds ticket.diagnostics to the last 10 entries", async () => {
    const existing = Array.from({ length: 10 }, (_, i) => ({
      runId: `run_old_${i}` as RunId,
      at: FIXED_NOW.toISOString(),
      outcome: { kind: "completed" as const, durationMs: 1, report: mockReport("reachable") },
      decision: { kind: "escalate" as const, reason: "not_allowlisted" as const },
    }));
    const ticket = baseTicket({ diagnostics: existing });
    const p = ports(
      ticket,
      catalogResolving({ kind: "tcp", host: "vpn", port: 443 }),
      runnerReturning({ kind: "completed", durationMs: 1, report: mockReport("reachable") }),
    );
    await runDiagnostic(p, { ticketId: ticket.id, actor: "diagnostic" });
    const saved = p.ticketRepository.saved[0];
    expect(saved?.diagnostics).toHaveLength(10);
    expect(saved?.diagnostics[9]?.runId).toBe("run_new");
  });

  it("appends a diagnostic.completed audit entry with the decision", async () => {
    const ticket = baseTicket();
    const p = ports(
      ticket,
      catalogResolving({ kind: "tcp", host: "vpn", port: 443 }),
      runnerReturning({ kind: "completed", durationMs: 1, report: mockReport("reachable") }),
    );
    await runDiagnostic(p, { ticketId: ticket.id, actor: "diagnostic" });
    expect(p.auditLog.entries.map((e) => e.type)).toEqual(["diagnostic.completed"]);
  });
});

describe("runDiagnostic — runner failure", () => {
  it("never passes a runner failure into decideRemediation and escalates instead", async () => {
    const ticket = baseTicket();
    const p = ports(
      ticket,
      catalogResolving({ kind: "tcp", host: "vpn", port: 443 }),
      runnerReturning({ kind: "failed", reason: "timeout", durationMs: 3000 }),
    );
    const result = await runDiagnostic(p, { ticketId: ticket.id, actor: "diagnostic" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision.kind).toBe("escalate");
    expect(result.value.outcome).toBe("failed");
  });

  it("appends a diagnostic.failed audit entry", async () => {
    const ticket = baseTicket();
    const p = ports(
      ticket,
      catalogResolving({ kind: "tcp", host: "vpn", port: 443 }),
      runnerReturning({ kind: "failed", reason: "spawn_error", durationMs: 1 }),
    );
    await runDiagnostic(p, { ticketId: ticket.id, actor: "diagnostic" });
    expect(p.auditLog.entries.map((e) => e.type)).toEqual(["diagnostic.failed"]);
  });
});

function mockReport(status: "reachable" | "degraded" | "unreachable") {
  return {
    schemaVersion: 1 as const,
    probe: "connectivity" as const,
    mode: "mock" as const,
    target: "tcp://vpn.internal.example.com:443",
    status,
    checks: [{ name: "tcp" as const, ok: status === "reachable", latencyMs: 10 }],
    startedAt: FIXED_NOW.toISOString(),
    finishedAt: FIXED_NOW.toISOString(),
  };
}
