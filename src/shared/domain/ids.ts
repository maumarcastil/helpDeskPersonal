import type { Brand } from "../kernel/brand.js";

/**
 * Branded id types shared across capabilities. Kept in `shared/domain`
 * (not `shared/kernel`) because they encode domain vocabulary — ticket,
 * diagnostic run and audit entry identity — not generic technical
 * machinery. `shared/ports/id-generator.ts` imports these to type its
 * `IdGenerator` port. Each owning capability re-exports its id type from
 * its own domain module for ergonomics (see `tickets/domain/ticket.ts`).
 */
export type TicketId = Brand<string, "TicketId">;
export type RunId = Brand<string, "RunId">;
export type AuditId = Brand<string, "AuditId">;
