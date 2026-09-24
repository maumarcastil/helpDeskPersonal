import type { Category, Subcategory } from "../../tickets/domain/categories.js";
import type { EscalationReason } from "../../tickets/domain/ticket.js";
import type { ProbeStatus } from "./diagnostic-report.js";
import { ALLOWLIST, type RemediationAction } from "./remediation-allowlist.js";

/**
 * The remediation allowlist's actual key shape (spec-v2 corrects the
 * earlier generic `{category, diagnosticResult}` description). This type
 * structurally cannot represent a runner failure — `status` is `ProbeStatus`
 * (`reachable`|`degraded`|`unreachable`), never a `RunnerFailureReason` — so
 * a caller holding a `RunnerOutcome.kind === 'failed'` cannot construct a
 * value of this type at all; it must short-circuit to `escalate` itself
 * before ever calling `decideRemediation` (design "Runner failure never
 * reaches the remediation allowlist as a diagnosticResult").
 */
export interface RemediationMatchKey {
  readonly category: Category;
  readonly subcategory: Subcategory;
  readonly probe: "connectivity";
  readonly status: ProbeStatus;
}

export type RemediationDecision =
  | { readonly kind: "remediate"; readonly entryId: string; readonly action: RemediationAction }
  | { readonly kind: "escalate"; readonly reason: EscalationReason };

/**
 * Pure allowlist lookup (spec `remediation-policy`, all 3 scenarios). Every
 * unmatched combination — wrong category/subcategory, or a `degraded`/
 * `unreachable` status even for an otherwise-allowlisted pair, since every
 * `ALLOWLIST` entry only matches `status: 'reachable'` — escalates with
 * reason `not_allowlisted`.
 */
export function decideRemediation(key: RemediationMatchKey): RemediationDecision {
  const entry = ALLOWLIST.find(
    (candidate) =>
      candidate.match.category === key.category &&
      candidate.match.subcategory === key.subcategory &&
      candidate.match.probe === key.probe &&
      candidate.match.status === key.status,
  );
  if (!entry) {
    return { kind: "escalate", reason: "not_allowlisted" };
  }
  return { kind: "remediate", entryId: entry.id, action: entry.action };
}
