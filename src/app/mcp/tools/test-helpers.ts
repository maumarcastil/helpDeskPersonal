import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditEntry } from "../../../audit/domain/audit-entry.js";
import type { AuditLog } from "../../../audit/ports/audit-log.js";
import type { AuditId, TicketId } from "../../../shared/domain/ids.js";
import type { Ticket } from "../../../tickets/domain/ticket.js";
import type { TicketListFilter, TicketRepository } from "../../../tickets/ports/ticket-repository.js";
import type { Ports } from "../../composition-root.js";
import { buildApp } from "../../composition-root.js";
import { findPackageRoot, loadConfig } from "../../config/load-config.js";
import { createServer } from "../server.js";

/** Test-only support module (not itself under test) shared by every MCP
 *  tool handler test in this phase, so the SDK Client + InMemoryTransport +
 *  in-memory fake bootstrap is written once. */

export const REAL_PACKAGE_ROOT = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

export class InMemoryTicketRepository implements TicketRepository {
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
      return { ok: false as const, error: { code: "CONFLICT" as const, message: "version mismatch" } };
    }
    this.store.set(ticket.id, { ticket, version: ticket.version });
    return { ok: true as const, value: undefined };
  }

  async list(filter: TicketListFilter): Promise<readonly Ticket[]> {
    let tickets = [...this.store.values()].map((entry) => entry.ticket);
    if (filter.state !== undefined) tickets = tickets.filter((t) => t.state === filter.state);
    if (filter.category !== undefined) {
      tickets = tickets.filter((t) => t.triage?.category === filter.category);
    }
    if (filter.priority !== undefined) {
      tickets = tickets.filter((t) => t.triage?.priority === filter.priority);
    }
    return tickets;
  }
}

export class InMemoryAuditLog implements AuditLog {
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

export interface TestHarness {
  readonly client: Client;
  readonly ticketRepository: InMemoryTicketRepository;
  readonly auditLog: InMemoryAuditLog;
  close(): Promise<void>;
}

/** Builds a real `McpServer` (via `createServer`/`buildApp`) linked to a
 *  fresh SDK `Client` over an `InMemoryTransport` pair. `ticketRepository`
 *  and `auditLog` are always the in-memory fakes above (so tests can
 *  inspect stored state directly); `extraOverrides` lets a test also fake
 *  `serviceCatalog`/`diagnosticRunner`/`clock`/etc. for the diagnostics
 *  tools. */
export async function buildTestHarness(extraOverrides: Partial<Ports> = {}): Promise<TestHarness> {
  const ticketRepository = new InMemoryTicketRepository();
  const auditLog = new InMemoryAuditLog();
  const config = loadConfig(
    { HELPDESK_PSEUDONYM_KEY: "test-key" },
    { packageRoot: REAL_PACKAGE_ROOT, stderr: { write: () => true } },
  );
  const app = buildApp(config, { ticketRepository, auditLog, ...extraOverrides });
  const server = createServer(app);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return {
    client,
    ticketRepository,
    auditLog,
    close: () => client.close(),
  };
}
