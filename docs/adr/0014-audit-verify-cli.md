# 0014. Audit-chain verification CLI (`audit:verify`)

- Status: Accepted
- Date: 2026-09-24

## Context

The audit log is hash-chained and the domain helper `verifyChain`
(`src/audit/domain/hash-chain.ts`) detects tampering with a single
recomputation pass. The helper is unit-tested and exercised by
`JsonlAuditLog`'s own test suite (it is the same helper that confirms
a fresh-on-disk file on reopen), but it had no operator-facing entry
point: confirming a known-good baseline before a deploy, or triaging
a suspicion of tampering, required spinning up a model session and
calling a chain of MCP tools by hand. The README's "Known limitations"
section called this gap out explicitly.

## Decision

Expose `verifyChain` as a CLI: `npm run audit:verify [path/to/audit.jsonl]`
(default path: `data/audit.jsonl`, relative to the caller's cwd). The
script (`scripts/audit-verify.ts`) reads the JSONL line by line,
recomputes every entry's hash with `node:crypto.createHash("sha256")`,
and reports the result.

- **Exit code 0** — the chain is valid; stdout prints
  `ok: <path> (chain valid, <N> entries)`.
- **Exit code 1** — the chain is broken at the printed `seq`; the
  operator learns which entry to inspect without having to load the
  file in a tool. Both `prevHash` mismatches (entry deleted,
  reordered, or its `prevHash` field overwritten) and content
  mutations surface here.
- **Exit code 2** — input error (file does not exist, or a line that
  does not parse as a JSON object). An empty / missing log is treated
  as a valid empty chain (exit 0, `0 entries`).
- **Exit code 3** — internal error (catch-all for unexpected throws;
  mirrors `connectivity-probe.ts`'s contract).

The CLI is **standalone**: it imports `verifyChain` from the domain
layer (the only cross-capability import), uses `node:crypto` directly
for SHA-256, and never touches the `AuditLog` port. That keeps the
append-only surface (`append`, `listByTicket`) unchanged and avoids
dragging the runtime's file-backed adapter into the CLI process.

## Alternatives considered

- **MCP tool (`verify_audit_chain`)** — rejected for now: the operator
  wants to verify *outside* the model session, and an MCP tool would
  require a fresh model run to invoke. The CLI is reachable from any
  shell. If a programmatic consumer ever needs it, adding the tool
  later is a small extension that reuses the same `verifyChain`
  helper.
- **Verification on every MCP-server startup** — rejected: scanning
  the full log on boot would block the server for minutes as the
  audit history grows, and a failure mode would prevent the server
  from starting at all. Tamper detection should be on demand, not
  boot-blocking.
- **Extend the `AuditLog` port with `readAll()`** — rejected: the
  port's surface is intentionally minimal (append + listByTicket) and
  the audit-log design comment treats "no update/delete method" as
  itself the enforcement of the append-only contract. The CLI does
  not need the runtime's append semantics, so it reads the file
  directly with `node:fs` + `node:readline` instead.

## Consequences

**Positive**

- Operators can confirm a baseline, triage a tampering suspicion, and
  diff two audit logs without leaving the shell.
- The pure domain helper stays the single source of truth for chain
  verification — there is no second implementation to drift.
- No change to the runtime's append-only surface or its compile-time
  port guards.

**Negative**

- The CLI is a separate code path; a regression in `verifyChain` that
  the unit tests miss would affect both the runner and the CLI
  equally. Mitigated by the existing unit tests over the domain
  helper, which cover both tampering patterns the runtime tests rely
  on (content mutation, prevHash mutation).
- A future MCP-server startup-time verification hook (see "Alternatives
  considered") is not covered by this ADR — it is a separate decision
  if/when it is needed.