/**
 * Every pattern kind `redact()` can find and replace. `<KIND>` is the
 * literal name embedded in the `[REDACTED:<KIND>]` marker (spec
 * `sensitive-data-redaction` -> "Redaction marker matches the exact
 * documented format").
 */
export type RedactionKind =
  | "PRIVATE_KEY"
  | "JWT"
  | "AUTH_HEADER"
  | "URL_CREDENTIALS"
  | "AWS_KEY"
  | "GITHUB_TOKEN"
  | "SLACK_TOKEN"
  | "SECRET_ASSIGNMENT"
  | "EMAIL"
  | "CARD"
  | "IBAN"
  | "NATIONAL_ID"
  | "PHONE"
  | "HIGH_ENTROPY";

export interface RedactionPattern {
  readonly kind: RedactionKind;
  readonly regex: RegExp;
  /** Extra check beyond the regex match (e.g. Luhn for card numbers). */
  readonly validate?: (matchedText: string) => boolean;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let doubleNext = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (doubleNext) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleNext = !doubleNext;
  }
  return sum % 10 === 0;
}

function digitsOnly(text: string): string {
  return text.replace(/\D/g, "");
}

/** Matches this system's own opaque ids (see the `HIGH_ENTROPY` pattern's
 *  `validate` below for why they must be excluded). */
const INTERNAL_ID_RE = /^(?:(?:tkt|run|aud)_[0-9a-f]{32}|usr_[0-9a-f]{16})$/;

/**
 * Ordered specific-before-generic (design "Redaction" section): a pattern
 * earlier in this array claims a matched region before any later pattern
 * gets a chance at the same characters (see `redact()`'s overlap
 * resolution), so e.g. `PRIVATE_KEY`/`JWT` win over `HIGH_ENTROPY` on the
 * same substring.
 */
export const REDACTION_PATTERNS: readonly RedactionPattern[] = [
  {
    kind: "PRIVATE_KEY",
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    kind: "JWT",
    regex: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  },
  {
    kind: "AUTH_HEADER",
    regex: /\b(?:Bearer|Basic)\s+[A-Za-z0-9\-_.=+/]{8,}/g,
  },
  {
    kind: "URL_CREDENTIALS",
    regex: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/g,
  },
  {
    kind: "AWS_KEY",
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    kind: "GITHUB_TOKEN",
    regex: /\bgh[poasr]_[A-Za-z0-9]{20,}\b/g,
  },
  {
    kind: "SLACK_TOKEN",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    kind: "SECRET_ASSIGNMENT",
    regex: /\b(?:password|passwd|pwd|pass|contraseña|clave|secret|token|api[\s_-]?key)\s*(?:is|es|:|=)\s*\S+/gi,
  },
  {
    kind: "EMAIL",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    kind: "CARD",
    regex: /\b(?:\d[ -]?){13,19}\b/g,
    validate: (matched) => {
      const digits = digitsOnly(matched);
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
    },
  },
  {
    kind: "IBAN",
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
  },
  {
    kind: "NATIONAL_ID",
    regex: /\b(?:\d{8}[A-Z]|[XYZ]\d{7}[A-Z]|\d{3}-\d{2}-\d{4})\b/g,
  },
  {
    kind: "PHONE",
    regex: /\+?\d{1,3}?[ -]?\(?\d{2,4}\)?(?:[ -]\d{2,4}){2,4}\b/g,
    validate: (matched) => {
      const digits = digitsOnly(matched);
      return digits.length >= 7 && digits.length <= 15;
    },
  },
  {
    kind: "HIGH_ENTROPY",
    regex: /\b[A-Za-z0-9+/_=-]{32,}\b/g,
    validate: (matched) => {
      // This system's own opaque ids (`CryptoIdGenerator`: `tkt_`/`run_`/
      // `aud_` + 32 lowercase-hex chars; `HmacPseudonymizer`: `usr_` + 16
      // lowercase-hex chars) are identifiers, not secrets. Every MCP tool
      // response is redacted wholesale (defense in depth, task 4.5), so
      // without this exclusion a client could never receive a usable
      // ticket/run/audit id — discovered when wiring the first MCP tool.
      if (INTERNAL_ID_RE.test(matched)) return false;
      const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[+/_=-]/].filter((re) =>
        re.test(matched),
      ).length;
      return classes >= 3;
    },
  },
];
