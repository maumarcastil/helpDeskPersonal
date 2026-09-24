import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AuditEntry } from "../audit/domain/audit-entry.js";
import type { AuditLog } from "../audit/ports/audit-log.js";
import type { ImpactedService } from "../tickets/domain/ticket.js";
import type { ProbeTarget } from "../diagnostics/ports/diagnostic-runner.js";
import type { DiagnosticRequest, DiagnosticRunner } from "../diagnostics/ports/diagnostic-runner.js";
import type { ServiceCatalog } from "../diagnostics/ports/service-catalog.js";
import type { RunnerOutcome } from "../diagnostics/domain/runner-outcome.js";
import type { AuditId, TicketId } from "../shared/domain/ids.js";
import type { Ticket } from "../tickets/domain/ticket.js";
import type { TicketListFilter, TicketRepository } from "../tickets/ports/ticket-repository.js";
import { findPackageRoot, loadConfig } from "./config/load-config.js";
import { __resetConfigWarningLatchForTests, buildApp } from "./composition-root.js";
import { SystemClock } from "./system/system-clock.js";
import { CryptoIdGenerator } from "./system/crypto-id-generator.js";
import { ChildProcessDiagnosticRunner } from "../diagnostics/infrastructure/child-process-diagnostic-runner.js";
import { JsonFileTicketRepository } from "../tickets/infrastructure/json-file-ticket-repository.js";

const REAL_PACKAGE_ROOT = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

class InMemoryTicketRepository implements TicketRepository {
  private readonly store = new Map<string, { ticket: Ticket; version: number }>();

  async getById(id: TicketId): Promise<Ticket | null> {
    return this.store.get(id)?.ticket ?? null;
  }

  async save(ticket: Ticket, expectedVersion: number) {
    const existing = this.store.get(ticket.id);
    const currentVersion = existing?.version ?? 0;
    if (currentVersion !== expectedVersion) {
      return { ok: false as const, error: { code: "CONFLICT" as const, message: "version mismatch" } };
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

class StubServiceCatalog implements ServiceCatalog {
  resolve(_service: ImpactedService): ProbeTarget | null {
    return null;
  }
  list(): readonly ImpactedService[] {
    return [];
  }
}

class StubDiagnosticRunner implements DiagnosticRunner {
  async run(_request: DiagnosticRequest): Promise<RunnerOutcome> {
    throw new Error("not used in this test");
  }
}

function realConfig(overrides: Partial<Parameters<typeof loadConfig>[0]> = {}) {
  return loadConfig(
    { HELPDESK_PSEUDONYM_KEY: "test-key", ...overrides },
    { packageRoot: REAL_PACKAGE_ROOT, stderr: { write: () => true } },
  );
}

describe("buildApp", () => {
  it("wires every use case to the supplied port overrides (no real I/O for overridden ports)", async () => {
    const ticketRepository = new InMemoryTicketRepository();
    const auditLog = new InMemoryAuditLog();
    const config = realConfig({
      // Deliberately impossible paths: if buildApp ever performed real I/O
      // against these instead of routing through the overrides, the test
      // would throw ENOENT rather than silently pass.
      HELPDESK_DATA_DIR: "/dev/null/does-not-exist",
      HELPDESK_SERVICE_CATALOG: "/dev/null/does-not-exist.json",
    });

    const { useCases } = buildApp(config, {
      ticketRepository,
      auditLog,
      serviceCatalog: new StubServiceCatalog(),
      diagnosticRunner: new StubDiagnosticRunner(),
    });

    const created = await useCases.createTicket({ text: "my password is Hunter2024!" });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");
    expect(created.value.ticket.description).not.toContain("Hunter2024!");

    const fetched = await useCases.getTicket({ ticketId: created.value.ticket.id });
    expect(fetched.ok).toBe(true);

    const listed = await useCases.listTickets({});
    expect(listed.tickets).toHaveLength(1);

    const auditNote = await useCases.appendAuditNote({
      ticketId: created.value.ticket.id,
      actor: "user",
      kind: "note",
      message: "a manual note",
    });
    expect(auditNote.ok).toBe(true);

    expect(auditLog.entries.some((e) => e.type === "ticket.created")).toBe(true);
  });

  it("constructs real default adapters when no overrides are supplied for a port", async () => {
    const tmpDataDir = mkdtempSync(join(tmpdir(), "helpdesk-composition-root-"));
    try {
      const config = realConfig({ HELPDESK_DATA_DIR: tmpDataDir });
      const { ports } = buildApp(config);

      expect(ports.clock).toBeInstanceOf(SystemClock);
      expect(ports.idGenerator).toBeInstanceOf(CryptoIdGenerator);
      expect(ports.ticketRepository).toBeInstanceOf(JsonFileTicketRepository);
      expect(ports.diagnosticRunner).toBeInstanceOf(ChildProcessDiagnosticRunner);

      // Real wiring works end to end against the tmp data dir.
      const { useCases } = buildApp(config);
      const created = await useCases.createTicket({ text: "hello" });
      expect(created.ok).toBe(true);
    } finally {
      rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });

  describe("HELPDESK_PSEUDONYM_KEY absent", () => {
    it("appends exactly one config.warning audit entry, even across repeated buildApp calls", async () => {
      __resetConfigWarningLatchForTests();
      const auditLog = new InMemoryAuditLog();
      const config = loadConfig(
        {},
        { packageRoot: REAL_PACKAGE_ROOT, stderr: { write: () => true } },
      );
      expect(config.pseudonymKeyIsDefault).toBe(true);

      const first = buildApp(config, { auditLog });
      const second = buildApp(config, { auditLog });
      await first.ready;
      await second.ready;

      const warnings = auditLog.entries.filter((e) => e.type === "config.warning");
      expect(warnings).toHaveLength(1);
    });

    it("appends no config.warning entry when the key is explicitly configured", async () => {
      __resetConfigWarningLatchForTests();
      const auditLog = new InMemoryAuditLog();
      const config = realConfig();

      const app = buildApp(config, { auditLog });
      await app.ready;

      expect(auditLog.entries.filter((e) => e.type === "config.warning")).toHaveLength(0);
    });
  });
});
