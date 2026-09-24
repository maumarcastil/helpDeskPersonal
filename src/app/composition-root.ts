import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { recordAuditEntry } from "../audit/application/audit-recorder.js";
import { NodeSha256Hasher } from "../audit/infrastructure/node-sha256-hasher.js";
import { JsonlAuditLog } from "../audit/infrastructure/jsonl-audit-log.js";
import type { AuditLog } from "../audit/ports/audit-log.js";
import type { Hasher } from "../audit/ports/hasher.js";
import { ChildProcessDiagnosticRunner } from "../diagnostics/infrastructure/child-process-diagnostic-runner.js";
import { JsonServiceCatalog } from "../diagnostics/infrastructure/json-service-catalog.js";
import type { DiagnosticRunner } from "../diagnostics/ports/diagnostic-runner.js";
import type { ServiceCatalog } from "../diagnostics/ports/service-catalog.js";
import {
  applyRemediation,
  type ApplyRemediationInput,
  type ApplyRemediationOutput,
} from "../diagnostics/application/apply-remediation.js";
import {
  runDiagnostic,
  type RunDiagnosticInput,
  type RunDiagnosticOutput,
} from "../diagnostics/application/run-diagnostic.js";
import { HmacPseudonymizer } from "../redaction/infrastructure/hmac-pseudonymizer.js";
import type { Pseudonymizer } from "../redaction/ports/pseudonymizer.js";
import type { DomainError } from "../shared/domain/domain-error.js";
import type { Result } from "../shared/kernel/result.js";
import type { Clock } from "../shared/ports/clock.js";
import type { IdGenerator } from "../shared/ports/id-generator.js";
import {
  appendAuditNote,
  type AppendAuditNoteInput,
  type AppendAuditNoteOutput,
} from "../audit/application/append-audit-note.js";
import {
  createTicket,
  type CreateTicketInput,
  type CreateTicketOutput,
} from "../tickets/application/create-ticket.js";
import { getTicket, type GetTicketInput, type GetTicketOutput } from "../tickets/application/get-ticket.js";
import {
  listTickets,
  type ListTicketsInput,
  type ListTicketsOutput,
} from "../tickets/application/list-tickets.js";
import {
  transitionTicket,
  type TransitionTicketInput,
  type TransitionTicketOutput,
} from "../tickets/application/transition-ticket.js";
import { JsonFileTicketRepository } from "../tickets/infrastructure/json-file-ticket-repository.js";
import type { TicketRepository } from "../tickets/ports/ticket-repository.js";
import type { AppConfig } from "./config/load-config.js";
import { CryptoIdGenerator } from "./system/crypto-id-generator.js";
import { SystemClock } from "./system/system-clock.js";

const PROBE_SCRIPT_RELATIVE_PATH = join("scripts", "connectivity-probe.ts");
const TSX_BIN_RELATIVE_PATH = join("node_modules", ".bin", "tsx");

export interface Ports {
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly hasher: Hasher;
  readonly pseudonymizer: Pseudonymizer;
  readonly ticketRepository: TicketRepository;
  readonly auditLog: AuditLog;
  readonly serviceCatalog: ServiceCatalog;
  readonly diagnosticRunner: DiagnosticRunner;
}

export interface UseCases {
  createTicket(input: CreateTicketInput): Promise<Result<CreateTicketOutput, DomainError>>;
  getTicket(input: GetTicketInput): Promise<Result<GetTicketOutput, DomainError>>;
  listTickets(input: ListTicketsInput): Promise<ListTicketsOutput>;
  transitionTicket(
    input: TransitionTicketInput,
  ): Promise<Result<TransitionTicketOutput, DomainError>>;
  appendAuditNote(
    input: AppendAuditNoteInput,
  ): Promise<Result<AppendAuditNoteOutput, DomainError>>;
  runDiagnostic(input: RunDiagnosticInput): Promise<Result<RunDiagnosticOutput, DomainError>>;
  applyRemediation(
    input: ApplyRemediationInput,
  ): Promise<Result<ApplyRemediationOutput, DomainError>>;
}

export interface BuiltApp {
  readonly useCases: UseCases;
  /** Exposed so `main.ts` can, e.g., call `ports.diagnosticRunner.dispose()`
   *  on shutdown, and so tests can assert on which concrete adapter a
   *  non-overridden port resolved to. */
  readonly ports: Ports;
  /**
   * Resolves once any one-time startup side effect (currently: the
   * `config.warning` audit entry for a missing `HELPDESK_PSEUDONYM_KEY`) has
   * settled. `buildApp` itself stays synchronous so callers who don't care
   * about that side effect can use the returned `useCases` immediately;
   * tests asserting on the warning should await this.
   */
  readonly ready: Promise<void>;
}

function buildDefaultPorts(config: AppConfig, overrides: Partial<Ports>): Ports {
  const hasher = overrides.hasher ?? new NodeSha256Hasher();

  // A fresh checkout has no `data/` directory at all - without this, the
  // very first write (either adapter, whichever runs first) fails with
  // ENOENT before the server can serve a single tool call. Only needed
  // when at least one of the two file-backed ports isn't overridden by a
  // test double, and only ever touches the real filesystem in that case.
  if (overrides.ticketRepository === undefined || overrides.auditLog === undefined) {
    mkdirSync(config.dataDir, { recursive: true });
  }

  return {
    clock: overrides.clock ?? new SystemClock(),
    idGenerator: overrides.idGenerator ?? new CryptoIdGenerator(),
    hasher,
    pseudonymizer: overrides.pseudonymizer ?? new HmacPseudonymizer(config.pseudonymKey),
    ticketRepository:
      overrides.ticketRepository ??
      new JsonFileTicketRepository(join(config.dataDir, "tickets.json")),
    auditLog: overrides.auditLog ?? new JsonlAuditLog(join(config.dataDir, "audit.jsonl"), hasher),
    serviceCatalog: overrides.serviceCatalog ?? new JsonServiceCatalog(config.serviceCatalogPath),
    diagnosticRunner:
      overrides.diagnosticRunner ??
      new ChildProcessDiagnosticRunner({
        scriptPath: join(config.packageRoot, PROBE_SCRIPT_RELATIVE_PATH),
        tsxBinPath: join(config.packageRoot, TSX_BIN_RELATIVE_PATH),
        parentEnv: { ...process.env, HELPDESK_PROBE_MODE: config.probeMode },
      }),
  };
}

let warnedInAuditThisProcess = false;

/**
 * Appends the one `config.warning` audit entry a missing
 * `HELPDESK_PSEUDONYM_KEY` requires (design "Composition root"), guarded by
 * a module-level latch so calling `buildApp` more than once in the same
 * process (every handler test does this) never appends a second entry. The
 * stderr side of this warning is `loadConfig`'s own, separate, once-only
 * latch (task 4.1) - a pure config loader has no `AuditLog` to write to.
 */
async function recordPseudonymKeyWarningOnce(ports: Pick<Ports, "auditLog" | "clock" | "idGenerator">): Promise<void> {
  if (warnedInAuditThisProcess) return;
  warnedInAuditThisProcess = true;
  await recordAuditEntry(ports.auditLog, ports.clock, {
    id: ports.idGenerator.auditId(),
    actor: "system",
    type: "config.warning",
    message: "HELPDESK_PSEUDONYM_KEY is not set; using the built-in development key.",
  });
}

/**
 * Composition root (design "Composition root"; ADR 0013 - lives under
 * `src/app/`, not a global `src/infrastructure/`). Wires every driven
 * adapter and every Phase 2 use case behind their ports, and binds the
 * ports into ready-to-call `useCases` functions so a driving adapter (the
 * MCP tool handlers, this phase) never sees a raw port object. `overrides`
 * lets a caller (test or otherwise) substitute any subset of ports with a
 * fake; only the non-overridden ports are actually constructed, so an
 * overridden port never performs real file or process I/O.
 */
export function buildApp(config: AppConfig, overrides: Partial<Ports> = {}): BuiltApp {
  const ports = buildDefaultPorts(config, overrides);

  const useCases: UseCases = {
    createTicket: (input) => createTicket(ports, input),
    getTicket: (input) => getTicket(ports, input),
    listTickets: (input) => listTickets(ports, input),
    transitionTicket: (input) => transitionTicket(ports, input),
    appendAuditNote: (input) => appendAuditNote(ports, input),
    runDiagnostic: (input) => runDiagnostic({ ...ports, timeoutMs: config.probeTimeoutMs }, input),
    applyRemediation: (input) => applyRemediation(ports, input),
  };

  const ready = config.pseudonymKeyIsDefault
    ? recordPseudonymKeyWarningOnce(ports)
    : Promise.resolve();

  return { useCases, ports, ready };
}

/** Test-only: resets the "have we already appended the config.warning audit
 *  entry this process" latch. */
export function __resetConfigWarningLatchForTests(): void {
  warnedInAuditThisProcess = false;
}
