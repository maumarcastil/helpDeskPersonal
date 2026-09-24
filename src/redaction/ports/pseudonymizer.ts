import type { Pseudonym } from "../domain/pseudonymize.js";

/**
 * Port for pseudonymizing a raw identifier into a `Pseudonym` (design
 * "Use cases" -> TransitionTicket "Pseudonymizer(key)"; ADR 0008, 0012).
 * Implemented by `HmacPseudonymizer` (infrastructure), which is
 * constructed once with the deployment's key (`HELPDESK_PSEUDONYM_KEY`) so
 * every call site only ever sees the raw value, never the key.
 */
export interface Pseudonymizer {
  pseudonymize(raw: string): Pseudonym;
}
