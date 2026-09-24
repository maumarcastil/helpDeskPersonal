import { randomBytes } from "node:crypto";
import type { AuditId, RunId, TicketId } from "../../shared/domain/ids.js";
import type { IdGenerator } from "../../shared/ports/id-generator.js";

/** 64 bits of entropy per id = 16 lowercase hex chars; plenty to keep the
 *  birthday-paradox collision probability negligible at the volumes this
 *  system handles, and long enough to satisfy the "≥16 chars after the
 *  prefix" requirement for `Opaque` ids. */
const SUFFIX_HEX_LENGTH = 16;

/** Prefixes are the wire format the rest of the system already uses (test
 *  fixtures cast ids like `"tkt_new"` / `"run_unused"` / `"aud_unused"`),
 *  and the type-level tests in `ports/id-generator.ts` use them as the
 *  expected shape. `aud_` is the existing short form used by
 *  `audit-recorder`'s callers. */
const TICKET_PREFIX = "tkt_";
const RUN_PREFIX = "run_";
const AUDIT_PREFIX = "aud_";

/**
 * Production `IdGenerator` adapter (Phase 3, ADR 0013). Uses
 * `node:crypto.randomBytes` so the entropy source is the OS CSPRNG —
 * sufficient for uniqueness across `n` ids where `n << 2^32`. Lives in
 * `src/app/system/` because every capability's use cases consume a
 * `Clock`/`IdGenerator` port, not just one capability.
 */
export class CryptoIdGenerator implements IdGenerator {
  ticketId(): TicketId {
    return `${TICKET_PREFIX}${randomBytes(SUFFIX_HEX_LENGTH).toString("hex")}` as TicketId;
  }

  runId(): RunId {
    return `${RUN_PREFIX}${randomBytes(SUFFIX_HEX_LENGTH).toString("hex")}` as RunId;
  }

  auditId(): AuditId {
    return `${AUDIT_PREFIX}${randomBytes(SUFFIX_HEX_LENGTH).toString("hex")}` as AuditId;
  }
}
