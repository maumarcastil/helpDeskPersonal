import type { Brand } from "./brand.js";

/**
 * Branded id types shared across capabilities. Defined here (rather than
 * inside each owning capability's domain module, e.g. `tickets/domain/
 * ticket.ts`) so the `IdGenerator` port below can reference all three
 * without creating a shared -> tickets/diagnostics/audit import cycle —
 * `shared` has no dependencies, everything else depends on it. Each
 * owning capability re-exports its id type from its own domain module for
 * ergonomics (see `tickets/domain/ticket.ts`).
 */
export type TicketId = Brand<string, "TicketId">;
export type RunId = Brand<string, "RunId">;
export type AuditId = Brand<string, "AuditId">;

/**
 * Port for generating new ids. Implemented by `CryptoIdGenerator`
 * (infrastructure, Phase 3).
 */
export interface IdGenerator {
  ticketId(): TicketId;
  runId(): RunId;
  auditId(): AuditId;
}
