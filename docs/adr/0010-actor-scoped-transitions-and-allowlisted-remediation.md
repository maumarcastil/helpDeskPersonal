# 0010. Actor-scoped transitions and allowlisted remediation

- Status: Accepted
- Date: 2026-09-23

## Context

ADR 0003 states that the server enforces forward-only agent transitions so prompt-driven handoffs in Claude Code and OpenCode stay safe. MCP offers no caller identity, and the test requires that remediation happen only when deterministic and safe, with the Triage agent holding no remediation capability.

## Decision

- Every state-changing tool call carries an `actor` (`triage`, `diagnostic`, `escalation`, `user`, `human-agent`, `system`). The transition table lists, per rule, which actors may perform it. Agent actors may only perform transitions to a strictly higher state rank; `Reopened` is reachable only by `user`.
- Remediation is a dedicated tool, `apply_remediation(ticketId, actor, runId)`. The server looks up the referenced completed diagnostic run, matches `{category, subcategory, probeStatus}` against a typed allowlist whose actions are all reversible and mutate only this system's own simulated state, applies the action, and moves the ticket to `PendingUserConfirmation`. Anything not allowlisted returns `NOT_ALLOWLISTED` and the agent must escalate.
- Each platform agent is generated without tools its role must not use (ADR 0009), so the actor claim and the tool list agree.

## Alternatives considered

- **Remediation as a free-form field on `update_ticket`** — rejected: the model could name any action; the server would have to re-derive the decision anyway.
- **Authenticated callers** — rejected: out of scope (no MCP caller auth in this MVP).

## Consequences

**Positive**

- Lifecycle correctness and remediation safety do not depend on which platform or model is driving.

**Negative**

- `actor` is self-declared; a misbehaving client could claim another role. Mitigated by per-agent tool lists and the audit trail, not prevented.
