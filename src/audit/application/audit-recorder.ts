import { redact, redactDeep } from "../../redaction/domain/redact.js";
import type { AuditId, TicketId } from "../../shared/domain/ids.js";
import type { Clock } from "../../shared/ports/clock.js";
import type { Actor } from "../../tickets/domain/ticket.js";
import type { AuditEventType, JsonValue, RedactionFindingSummary } from "../domain/audit-entry.js";
import type { AuditLog } from "../ports/audit-log.js";

export interface RecordAuditEntryInput {
  /** Minted by the caller via `IdGenerator.auditId()` before calling this
   * funnel (`AuditLog.append` now requires a caller-supplied id). */
  readonly id: AuditId;
  readonly ticketId?: TicketId;
  readonly actor: Actor;
  readonly type: AuditEventType;
  /** Raw text; redacted here before ever reaching `AuditLog.append`. */
  readonly message: string;
  /** Raw structured data; every string leaf is redacted here via `redactDeep`. */
  readonly data?: Record<string, JsonValue>;
}

/**
 * Single funnel every use case goes through to append an audit entry
 * (design "Audit" -> `audit-recorder.ts`, "used by other use cases").
 * Centralizing the redact-then-append call here is what makes redaction
 * "occur in the domain layer... so it cannot be bypassed by a specific
 * driven adapter" (spec `sensitive-data-redaction`) practically true: no
 * use case constructs an `AuditEntry` by hand.
 */
export async function recordAuditEntry(
  auditLog: AuditLog,
  clock: Clock,
  input: RecordAuditEntryInput,
): Promise<AuditId> {
  const { text: message, findings: messageFindings } = redact(input.message);
  const data = input.data ? redactDeep(input.data) : {};

  const dataFindings: RedactionFindingSummary[] = collectDataFindings(input.data);
  const findings = mergeFindings(messageFindings, dataFindings);

  return auditLog.append({
    id: input.id,
    at: clock.now().toISOString(),
    ...(input.ticketId !== undefined ? { ticketId: input.ticketId } : {}),
    actor: input.actor,
    type: input.type,
    message,
    data,
    ...(findings.length > 0 ? { redactionFindings: findings } : {}),
  });
}

/**
 * `redactDeep` itself doesn't report findings (it only replaces string
 * leaves); to still surface findings for structured `data` without
 * duplicating pattern-matching logic, re-run `redact()` over every string
 * leaf found while walking the same structure.
 */
function collectDataFindings(value: unknown): RedactionFindingSummary[] {
  const findings: RedactionFindingSummary[] = [];
  walk(value, findings);
  return findings;
}

function walk(value: unknown, findings: RedactionFindingSummary[]): void {
  if (typeof value === "string") {
    findings.push(...redact(value).findings);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, findings);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      walk(nested, findings);
    }
  }
}

function mergeFindings(
  a: readonly RedactionFindingSummary[],
  b: readonly RedactionFindingSummary[],
): RedactionFindingSummary[] {
  const counts = new Map<string, number>();
  for (const finding of [...a, ...b]) {
    counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + finding.count);
  }
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
}
