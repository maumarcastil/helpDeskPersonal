import type { RedactedText } from "../../redaction/domain/redacted-text.js";
import type { AuditId, TicketId } from "../../shared/domain/ids.js";
import type { Actor } from "../../tickets/domain/ticket.js";

/**
 * Every audit decision type the system records (design "Audit" section).
 * Rejected transitions are audited too (`transition.rejected`), per
 * spec-v2 `audit-decision-log` -> "A rejected transition attempt is audited".
 */
export type AuditEventType =
  | "ticket.created"
  | "ticket.transitioned"
  | "transition.rejected"
  | "diagnostic.completed"
  | "diagnostic.failed"
  | "remediation.applied"
  | "remediation.refused"
  | "escalation.decided"
  | "agent.note"
  | "agent.decision"
  | "config.warning";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface RedactionFindingSummary {
  readonly kind: string;
  readonly count: number;
}

/**
 * Append-only, hash-chained decision log entry. `message` and every string
 * leaf under `data` are redacted before an entry is constructed (spec
 * `audit-decision-log` -> "Audit Entries Are Redacted"). `prevHash`/`hash`
 * are computed by `hash-chain.ts`, never supplied directly by a caller.
 */
export interface AuditEntry {
  readonly id: AuditId;
  readonly seq: number;
  readonly at: string;
  readonly ticketId?: TicketId;
  readonly actor: Actor;
  readonly type: AuditEventType;
  readonly message: RedactedText;
  readonly data: Readonly<Record<string, JsonValue>>;
  readonly redactionFindings?: readonly RedactionFindingSummary[];
  readonly prevHash: string;
  readonly hash: string;
}
