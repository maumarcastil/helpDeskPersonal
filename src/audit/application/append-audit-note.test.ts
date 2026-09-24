import { describe, expect, it } from "vitest";
import type { Clock } from "../../shared/ports/clock.js";
import type { IdGenerator } from "../../shared/ports/id-generator.js";
import type { AuditId, RunId, TicketId } from "../../shared/domain/ids.js";
import type { AuditEntry } from "../domain/audit-entry.js";
import type { AuditLog } from "../ports/audit-log.js";
import { appendAuditNote } from "./append-audit-note.js";

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");
const fixedClock: Clock = { now: () => FIXED_NOW };
const ticketId = "tkt_1" as TicketId;

class InMemoryAuditLog implements AuditLog {
  private seq = 0;
  readonly entries: AuditEntry[] = [];

  async append(entry: Omit<AuditEntry, "seq" | "prevHash" | "hash">): Promise<AuditId> {
    this.seq += 1;
    this.entries.push({
      ...entry,
      seq: this.seq,
      prevHash: "genesis",
      hash: `hash_${this.seq}`,
    });
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

function ports(auditLog: AuditLog) {
  return { auditLog, clock: fixedClock, idGenerator: new InMemoryIdGenerator() };
}

// Compile-time assertion: `AuditLog`'s public surface is exactly
// `{append, listByTicket}` — no update/delete operation exists to call
// (spec `audit-decision-log` -> "Attempt to modify a past entry is rejected").
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
  ? 1
  : 2
  ? true
  : false;
const auditLogSurfaceIsExact: Equal<keyof AuditLog, "append" | "listByTicket"> = true;

describe("AuditLog port surface", () => {
  it("has no update/delete operation on its type surface (compile-time)", () => {
    expect(auditLogSurfaceIsExact).toBe(true);
  });
});

describe("appendAuditNote", () => {
  it("accepts kind 'note' and maps it to type agent.note", async () => {
    const auditLog = new InMemoryAuditLog();
    const result = await appendAuditNote(
      ports(auditLog),
      { ticketId, actor: "diagnostic", kind: "note", message: "checked logs" },
    );
    expect(result.ok).toBe(true);
    expect(auditLog.entries[0]?.type).toBe("agent.note");
  });

  it("accepts kind 'agent_decision' and maps it to type agent.decision", async () => {
    const auditLog = new InMemoryAuditLog();
    await appendAuditNote(
      ports(auditLog),
      { ticketId, actor: "diagnostic", kind: "agent_decision", message: "escalating" },
    );
    expect(auditLog.entries[0]?.type).toBe("agent.decision");
  });

  it("rejects a message longer than 1000 characters", async () => {
    const auditLog = new InMemoryAuditLog();
    const longMessage = "x".repeat(1001);
    const result = await appendAuditNote(
      ports(auditLog),
      { ticketId, actor: "diagnostic", kind: "note", message: longMessage },
    );
    expect(result.ok).toBe(false);
    expect(auditLog.entries).toHaveLength(0);
  });

  it("redacts the message before it is appended", async () => {
    const auditLog = new InMemoryAuditLog();
    await appendAuditNote(
      ports(auditLog),
      {
        ticketId,
        actor: "diagnostic",
        kind: "note",
        message: "user password is Hunter2024!",
      },
    );
    const stored = auditLog.entries[0];
    expect(stored?.message).toContain("[REDACTED:SECRET_ASSIGNMENT]");
    expect(stored?.message).not.toContain("Hunter2024!");
  });

  it("mints the audit id via IdGenerator.auditId() and appends the entry under that exact id", async () => {
    const auditLog = new InMemoryAuditLog();
    const result = await appendAuditNote(
      ports(auditLog),
      { ticketId, actor: "diagnostic", kind: "note", message: "checked logs" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(auditLog.entries[0]?.id).toBe(result.value.auditRef);
    expect(auditLog.entries[0]?.id).toMatch(/^aud_gen_\d+$/);
  });

  it("returns entries via listByTicket in chronological (insertion) order", async () => {
    const auditLog = new InMemoryAuditLog();
    await appendAuditNote(
      ports(auditLog),
      { ticketId, actor: "diagnostic", kind: "note", message: "first" },
    );
    await appendAuditNote(
      ports(auditLog),
      { ticketId, actor: "diagnostic", kind: "note", message: "second" },
    );
    const entries = await auditLog.listByTicket(ticketId);
    expect(entries.map((e) => e.message)).toEqual(["first", "second"]);
  });
});
