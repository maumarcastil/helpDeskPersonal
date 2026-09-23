# 0008. Sensitive data redaction strategy

- Status: Accepted
- Date: 2026-09-23

## Context

The help desk must never store or disclose credentials, tokens, secrets, or PII in plain text. Ticket text is natural language written by users, who routinely paste passwords, emails, phone numbers, and tokens. The LLM reads that raw text before any code runs, so redaction cannot be perfect; it must be enforced wherever the deterministic core (ADR 0003) persists, logs, or returns data.

## Decision

- **One pure redaction module** (`src/redaction/domain`) with an ordered pattern set: PEM private keys, JWTs, bearer/basic authorization values, URL userinfo (`scheme://user:pass@`), provider tokens (AWS `AKIA…`, GitHub `gh[pousr]_…`, Slack `xox…`), `key/secret/token/password/contraseña/clave = value` assignments (English and Spanish keywords), emails, phone numbers, payment card numbers (Luhn-checked), IBANs, national-ID shapes, and long high-entropy strings (32+ chars). Each match becomes a typed placeholder such as `[REDACTED:EMAIL]`.
- **Type-enforced boundary**: free text inside the domain is a branded `RedactedText` type that can only be created by `redact()`. Ticket, audit, and diagnostic records only accept `RedactedText`, so unredacted text cannot reach a repository or the audit log without a compile error.
- **Applied at four points**: inbound MCP free-text fields (before use cases), domain construction (`RedactedText`), probe stdout/stderr excerpts, and a final deep pass over every MCP tool response.
- **Affected user pseudonymization**: `affectedUser` is stored as `usr_` + truncated HMAC-SHA256 with a server-side key (`HELPDESK_PSEUDONYM_KEY`) plus a masked display handle; the raw identifier is never persisted.
- **Instructions** tell every agent never to ask for or echo credentials and to pass only the ticket id and redacted summary on handoff.

## Alternatives considered

- **Prompt-only redaction** — rejected: non-deterministic across models and platforms (ADR 0003).
- **Reject tickets that contain secrets** — rejected: users would lose the ticket and the secret would still have been sent to the LLM.
- **External DLP service or NER model** — rejected: out of scope, adds network dependency; the pattern set is documented as the known limit.

## Consequences

**Positive**

- No known pattern can be persisted, logged, or returned; fixtures prove it in tests.
- The compiler enforces the "redact before persist" rule.

**Negative**

- The LLM still sees raw text before redaction; this is documented and mitigated by instructions only.
- Unknown secret formats and free-form personal names are not detected; the high-entropy rule causes some false positives on long identifiers.
- Escalation staff must resolve pseudonymized users out of band.
