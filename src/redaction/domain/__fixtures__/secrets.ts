import type { RedactionKind } from "../patterns.js";

/**
 * Shared redaction fixture corpus (task 2.1). No independent test — reused
 * by `redact.test.ts` (2.2) and, later, the MCP-layer "no fixture secret
 * leaks anywhere" test (4.11). English and Spanish positives per kind, plus
 * negatives that must survive `redact()` byte-identical.
 */
export interface RedactionFixture {
  readonly kind: RedactionKind;
  readonly label: string;
  /** Full sentence containing the secret, as it would appear in ticket text. */
  readonly text: string;
  /** The literal secret value that must not appear in redacted output. */
  readonly secretValue: string;
}

/**
 * Token-shaped fixtures are assembled at runtime so that no literal matching
 * a real provider's secret format exists in source: secret scanners (e.g.
 * GitHub push protection) would otherwise block the push. All values are fake.
 */
export const FAKE_JWT = [
  "eyJhbGciOiJIUzI1NiJ9",
  "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
  "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PYA_ATyEbXkE",
].join(".");
const FAKE_PEM = [
  "-----BEGIN RSA",
  "PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA",
  "PRIVATE KEY-----",
].join(" ");
const FAKE_AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP";
const FAKE_GITHUB_TOKEN = "ghp" + "_1234567890abcdefghijklmnopqrstuvwx";
const FAKE_SLACK_TOKEN = ["xoxb", "1234567890", "abcdefghijklmno"].join("-");

export const POSITIVE_FIXTURES: readonly RedactionFixture[] = [
  {
    kind: "SECRET_ASSIGNMENT",
    label: "password (English)",
    text: "my password is Hunter2024!",
    secretValue: "Hunter2024!",
  },
  {
    kind: "SECRET_ASSIGNMENT",
    label: "contraseña (Spanish)",
    text: "mi contraseña es Hunter2024!",
    secretValue: "Hunter2024!",
  },
  {
    kind: "SECRET_ASSIGNMENT",
    label: "api key (English)",
    text: "the api key: sk_live_abcdef123456",
    secretValue: "sk_live_abcdef123456",
  },
  {
    kind: "SECRET_ASSIGNMENT",
    label: "clave (Spanish)",
    text: "la clave: sk_live_abcdef123456",
    secretValue: "sk_live_abcdef123456",
  },
  {
    kind: "SECRET_ASSIGNMENT",
    label: "credential token (English)",
    text: "credential token=abc123XYZsecretvalue",
    secretValue: "abc123XYZsecretvalue",
  },
  {
    kind: "EMAIL",
    label: "email address",
    text: "please contact jane.doe@example.com for details",
    secretValue: "jane.doe@example.com",
  },
  {
    kind: "PHONE",
    label: "phone number with country code",
    text: "call me at +1 555-123-4567 tomorrow",
    secretValue: "+1 555-123-4567",
  },
  {
    kind: "PHONE",
    label: "phone number (Spanish, no country code)",
    text: "mi numero es 612 345 678 gracias",
    secretValue: "612 345 678",
  },
  {
    kind: "CARD",
    label: "card number (valid Luhn)",
    text: "the card number is 4111 1111 1111 1111 for the order",
    secretValue: "4111 1111 1111 1111",
  },
  {
    kind: "IBAN",
    label: "IBAN",
    text: "wire transfer to ES9121000418450200051332 please",
    secretValue: "ES9121000418450200051332",
  },
  {
    kind: "NATIONAL_ID",
    label: "DNI shape (Spanish)",
    text: "mi DNI es 12345678Z para el registro",
    secretValue: "12345678Z",
  },
  {
    kind: "NATIONAL_ID",
    label: "SSN shape (English)",
    text: "my SSN is 123-45-6789 on file",
    secretValue: "123-45-6789",
  },
  {
    kind: "JWT",
    label: "JWT",
    text: `auth response: ${FAKE_JWT} was returned`,
    secretValue: FAKE_JWT,
  },
  {
    kind: "PRIVATE_KEY",
    label: "PEM private key",
    text: `here is the key ${FAKE_PEM} thanks`,
    secretValue: FAKE_PEM,
  },
  {
    kind: "AUTH_HEADER",
    label: "Bearer auth header",
    text: "curl -H \"Authorization: Bearer abcDEF123456.token789value\" https://api.example.com",
    secretValue: "Bearer abcDEF123456.token789value",
  },
  {
    kind: "URL_CREDENTIALS",
    label: "URL-embedded credentials",
    text: "connect to https://admin:S3cretPass@db.internal.example.com:5432/app",
    secretValue: "https://admin:S3cretPass@db.internal.example.com:5432/app",
  },
  {
    kind: "AWS_KEY",
    label: "AWS access key id",
    text: `found ${FAKE_AWS_KEY} hardcoded in the script`,
    secretValue: FAKE_AWS_KEY,
  },
  {
    kind: "GITHUB_TOKEN",
    label: "GitHub personal access token",
    text: `${FAKE_GITHUB_TOKEN} was committed by mistake`,
    secretValue: FAKE_GITHUB_TOKEN,
  },
  {
    kind: "SLACK_TOKEN",
    label: "Slack bot token",
    text: `the bot uses ${FAKE_SLACK_TOKEN} for auth`,
    secretValue: FAKE_SLACK_TOKEN,
  },
  {
    kind: "HIGH_ENTROPY",
    label: "high-entropy string",
    text: "the generated value is: aB3fG7kL9mN2pQ5rS8tU1vW4xY6zA0bC3dE",
    secretValue: "aB3fG7kL9mN2pQ5rS8tU1vW4xY6zA0bC3dE",
  },
];

/** Text that must survive `redact()` byte-identical — no false positives. */
export const NEGATIVE_FIXTURES: readonly string[] = [
  "the VPN gateway at 192.168.1.10 is unreachable",
  "please check the DNS entry for vpn.corp.example.com",
  "related ticket TCK-2024-00013 was already resolved",
  "escalation reference TCK-2024-99999-A",
  "only 42 users were affected",
  "the queue had 12345 pending jobs",
  "server room is on floor 3",
];
