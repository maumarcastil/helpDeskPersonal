import { createHmac } from "node:crypto";
import type { Pseudonym } from "../domain/pseudonymize.js";
import type { Pseudonymizer } from "../ports/pseudonymizer.js";

const DIGEST_HEX_LENGTH = 16;

/**
 * `Pseudonymizer` adapter (ADR 0008, ADR 0012): `usr_` + the first 16 hex
 * chars of `HMAC-SHA256(key, raw)`, plus a masked display handle built
 * from the same digest slice. `key` is the deployment's pseudonym key
 * (`HELPDESK_PSEUDONYM_KEY`), bound once at construction so use cases only
 * ever see the raw value, never the key.
 */
export class HmacPseudonymizer implements Pseudonymizer {
  constructor(private readonly key: string) {}

  pseudonymize(raw: string): Pseudonym {
    const digest = createHmac("sha256", this.key)
      .update(raw, "utf8")
      .digest("hex")
      .slice(0, DIGEST_HEX_LENGTH);
    return {
      ref: `usr_${digest}`,
      display: `User ${digest.slice(0, 6)}`,
    };
  }
}
