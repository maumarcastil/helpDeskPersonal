/**
 * `Pseudonym` type + ref format rules for `triage.affectedUser` (design
 * "Type-enforced redaction + pseudonymized affected user"; ADR 0008;
 * `usr_<16 hex>` ref shape).
 *
 * The actual HMAC-SHA256 computation lives in the `Pseudonymizer` port
 * (`redaction/ports/pseudonymizer.ts`), implemented in infrastructure by
 * `HmacPseudonymizer` (`node:crypto`'s `createHmac`, ADR 0012): this file
 * lives under a domain folder, and the architecture guard (ADR 0011)
 * restricts domain third-party imports to `zod` only and forbids importing
 * any `ports/` path. This module therefore owns only the shape/format
 * contract the domain agrees to accept — no crypto, no key handling.
 */

export interface Pseudonym {
  readonly ref: string;
  readonly display: string;
}

const PSEUDONYM_REF_PATTERN = /^usr_[0-9a-f]{16}$/;

/** True when `ref` matches the domain's `usr_<16 lowercase hex>` pseudonym ref format. */
export function isValidPseudonymRef(ref: string): boolean {
  return PSEUDONYM_REF_PATTERN.test(ref);
}
