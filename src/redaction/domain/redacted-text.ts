import type { Brand } from "../../shared/kernel/brand.js";

/**
 * Text that has already passed through `redact()`/`redactDeep()`. Domain
 * constructors that store free text (ticket description, summary,
 * escalation note, resolution summary, reopen reason) accept only this
 * branded type, so a caller cannot bypass redaction by constructing a
 * `Ticket` directly with an unredacted `string` (design "Type-enforced
 * redaction", ADR 0008).
 *
 * Created alongside `redact.ts` (task 2.2) rather than strictly after it
 * (task 2.3's nominal file) because `redact()`'s return type needs it —
 * same forward-reference situation as `TicketId` in Phase 1. One-line
 * brand type, no behavior, no test impact.
 */
export type RedactedText = Brand<string, "RedactedText">;
