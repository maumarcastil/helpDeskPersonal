import type { AuditId, RunId, TicketId } from "../domain/ids.js";

/**
 * Port for generating new ids. Implemented by `CryptoIdGenerator`
 * (infrastructure, Phase 3). The id types themselves live in
 * `shared/domain/ids.ts`, not here — they are domain vocabulary, this
 * interface is the port that produces them.
 */
export interface IdGenerator {
  ticketId(): TicketId;
  runId(): RunId;
  auditId(): AuditId;
}
