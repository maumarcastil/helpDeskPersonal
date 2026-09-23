import { domainError } from "../../shared/domain/domain-error.js";
import { err, ok, type Result } from "../../shared/kernel/result.js";
import type { Level, Priority } from "./ticket.js";

/**
 * Severity x urgency -> priority matrix (spec `ticket-triage-priority` ->
 * Requirement "Severity x Urgency Priority Matrix"). Pure: same inputs
 * always produce the same output, no side effects, no I/O.
 */
const PRIORITY_MATRIX: Readonly<Record<Level, Readonly<Record<Level, Priority>>>> = {
  high: { high: "P1", medium: "P1", low: "P2" },
  medium: { high: "P1", medium: "P2", low: "P3" },
  low: { high: "P2", medium: "P3", low: "P3" },
};

const VALID_LEVELS: ReadonlySet<string> = new Set(["high", "medium", "low"]);

function isLevel(value: unknown): value is Level {
  return typeof value === "string" && VALID_LEVELS.has(value);
}

export function computePriority(
  severity: Level,
  urgency: Level,
): Result<Priority, ReturnType<typeof domainError>> {
  if (!isLevel(severity) || !isLevel(urgency)) {
    return err(
      domainError(
        "VALIDATION_ERROR",
        "severity and urgency must each be one of high, medium, low",
        { severity, urgency },
      ),
    );
  }
  return ok(PRIORITY_MATRIX[severity][urgency]);
}
