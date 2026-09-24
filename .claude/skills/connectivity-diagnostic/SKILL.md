---
name: connectivity-diagnostic
description: "Step-by-step connectivity diagnosis for a triaged help desk ticket. Use when a ticket in InProgress or PendingUserConfirmation reports that a catalogued service (VPN gateway, SSO identity provider, corporate internal app) cannot be reached, is slow, or keeps failing to connect, or when a remediated ticket needs a connectivity re-check before resolution. Runs the server-side connectivity probe through the helpdesk MCP server, applies an allowlisted fix when the server decides one is safe, and escalates to a human team otherwise. Do NOT use for untriaged or new tickets (triage first), for closed, resolved or already escalated tickets, for permission or license requests with no network symptom, for arbitrary hosts or URLs a user types in, or when you are not acting as the diagnostic agent."
---

# Connectivity diagnostic

Diagnose a connectivity problem on one help desk ticket by running the connectivity
probe **through the helpdesk MCP server**, then either apply the fix the server
allows or escalate. The server owns every rule (which host to probe, what counts as
safe to fix, which state changes are legal, redaction, audit). This skill only says
**which tool to call when** and how to talk to the user.

## When to use

- The ticket is triaged and its `triage.impactedService` is a network-reachable
  service (see `config/service-catalog.json`).
- The user reports "cannot connect", "VPN drops", "SSO page does not load", "the app
  times out", or similar reachability symptoms.
- A ticket in `PendingUserConfirmation` needs a fresh connectivity re-check before
  it can be resolved.

## When NOT to use

- Ticket is `New` or `Triaged` only → triage / move it to `InProgress` first.
- Ticket is `Escalated`, `Resolved` or `Closed` → nothing to diagnose.
- The request is about permissions, licenses or profile changes with no network
  symptom → no probe exists for it; escalate instead.
- The user asks you to "ping" or "test" a host or URL they name → refuse politely;
  probe targets only ever come from the server's service catalog.

## MCP tools

Tool names below are bare. Each platform prefixes them: VS Code `helpdesk/<tool>`,
Claude Code `mcp__helpdesk__<tool>`, OpenCode `helpdesk_<tool>`.

- `get_ticket` — read state, triage data and `allowedTransitions`.
- `run_diagnostic` — run the connectivity probe on the ticket's catalogued service.
- `apply_remediation` — apply the allowlisted fix a completed run decided on.
- `update_ticket` — escalate (or resolve after a confirmed re-check).
- `append_audit` — record an agent decision that no other tool call recorded.

## Preconditions

1. You act as actor `diagnostic` on every call. Never claim another actor.
2. The ticket has triage data (`ticket.triage` is present).
3. `ticket.state` is `InProgress` or `PendingUserConfirmation`.

If a precondition fails, do not call `run_diagnostic`; follow the matching row in
[Failure handling](#failure-handling).

## Procedure

1. **Read the ticket.** Call `get_ticket({ ticketId })`. Check the preconditions
   above against the returned ticket.
2. **Tell the user what happens next** in one plain sentence, e.g. "I'm going to
   check whether the VPN service is reachable from our side."
3. **Run the probe.** Call
   `run_diagnostic({ ticketId, actor: "diagnostic", probe: "connectivity" })`.
   Never pass a host, URL or port: the server resolves the target from the service
   catalog. The response is either a completed run (`runId`, `outcome: "completed"`,
   `decision`) or a runner failure (`outcome: "failed"`, `failureReason`,
   `decision.kind: "escalate"`), never both. The server has already written the
   audit entry for this run.
4. **Branch on `decision.kind`.**
   - `remediate` and the ticket is `InProgress` → call
     `apply_remediation({ ticketId, actor: "diagnostic", runId })`. The server moves
     the ticket to `PendingUserConfirmation` and returns a `userMessage`. Relay that
     message and ask the user to confirm whether the problem is gone.
   - `remediate` and the ticket is already `PendingUserConfirmation` → this was a
     re-check. Do not call `apply_remediation` again. If the user has confirmed the
     fix works, call
     `update_ticket({ ticketId, actor: "diagnostic", transition: { to: "Resolved", basis: "user-confirmed", diagnosticEvidence: { runId }, timestamp } })`
     with `timestamp` as the current ISO-8601 time. The server decides whether the
     re-check is good enough.
   - `escalate` → first check [Failure handling](#failure-handling) for the one
     allowed retry (`timeout` only). Otherwise call
     `update_ticket({ ticketId, actor: "diagnostic", transition: { to: "Escalated", escalationReason: decision.reason, target } })`
     passing `decision.reason` through unchanged and choosing `target` from
     [Escalation target](#escalation-target). Then relay the `userMessage` from
     `run_diagnostic`.
5. **Close the loop with the user** in plain language: what was checked, what was
   done (fix applied / handed to a named team), and what they should do next.

## Escalation target

The server only checks that `target` is one of its four teams; this table is a
routing suggestion based on `ticket.triage`.

| Triage category / subcategory | `target` |
|---|---|
| `access-identity` (any) | `identity-team` |
| `infrastructure-software` / `vpn` | `network-team` |
| `infrastructure-software` / `corporate-app` or `performance` | `desktop-support` |
| `provisioning-permissions` (any) | `access-management` |

## Failure handling

No retry loops. At most **one** retry, and only for `timeout`. Every other failure
escalates or stops immediately. Nothing is ever silent: each row ends with a message
to the user and a server-side record (the escalation, or an `append_audit` note).

| Signal | Meaning | What to do |
|---|---|---|
| `timeout` | The probe did not answer in time. | Retry `run_diagnostic` once. If the retry fails for any reason, escalate with `diagnostic_failed`. |
| `nonzero_exit` | The probe crashed or rejected its input. | Escalate with `diagnostic_failed`. Do not retry. |
| `malformed_output` | The probe answered with an invalid report. | Escalate with `diagnostic_failed`. Do not retry. |
| `output_too_large` | The probe answered with an oversized report. | Escalate with `diagnostic_failed`. Do not retry. |
| `spawn_error` | The probe could not be started at all. | Escalate with `diagnostic_failed`. Do not retry. |
| `no_diagnostic_available` | The impacted service has no probe in the catalog (no `runId`). | Escalate with `no_diagnostic_available`. |
| `not_allowlisted` | The probe ran but no safe automatic fix exists. | Escalate with `not_allowlisted`. |
| `TICKET_NOT_FOUND` | Wrong or unknown ticket id. | Ask the user to confirm the ticket reference. Stop. |
| `ACTOR_NOT_PERMITTED` | Wrong actor for this call or transition. | Stop. Do not retry as another actor. Record it with `append_audit` (`kind: "agent_decision"`). |
| `DIAGNOSTIC_NOT_USABLE` | Ticket is not in a diagnosable state, or the `runId` is stale or missing. | Re-read with `get_ticket`. If the state is wrong, stop and explain; never reuse an old `runId`. |
| `VALIDATION_ERROR` | Ticket not triaged, or a malformed payload. | Not triaged: hand back to triage. Payload: fix the arguments once, then stop. |
| `NOT_ALLOWLISTED` | `apply_remediation` refused the run. | Escalate with `not_allowlisted`. |
| `INVALID_TRANSITION` | The ticket moved to another state meanwhile. | Re-read with `get_ticket` and follow its `allowedTransitions`; never force a state. |
| `CONFLICT` | Someone else updated the ticket at the same time. | Re-read with `get_ticket` once, then repeat the single intended call. |
| `INTERNAL_ERROR` | Unexpected server fault. | Do not retry. Escalate with `diagnostic_failed` if `update_ticket` still answers; otherwise use the row below. |
| `MCP server/tool unavailable` | The helpdesk tools do not respond at all. | Tell the user the automated check is unavailable and a person will follow up. Do not claim the ticket was escalated or recorded, and do not diagnose by other means. |

## Rules

- Never supply, guess or accept a host, URL, IP or port. Targets come only from the
  server's service catalog.
- Never ask for, repeat or store passwords, tokens, one-time codes, API keys or
  personal data. If the user pastes one, do not echo it; tell them it is not needed.
- Relay `userMessage` in plain, jargon-free language. Do not show exit codes, raw
  reports or stack traces to the user.
- Do not re-implement server rules (safe-fix decisions, transitions, redaction).
  When the server refuses, follow [Failure handling](#failure-handling).
- Every run, fix and escalation is audited by the server; use `append_audit` only
  for a decision no other call recorded.

## Reference

Report schema, exit codes, mock scenarios and the full reason vocabulary:
[DiagnosticReport reference](references/diagnostic-report.md).

## Standalone use (operators)

Humans can run the same probe script (`scripts/connectivity-probe.ts`) outside the
MCP server, for example to reproduce a failure path offline:

```sh
npm run probe -- --target tcp://vpn.example.com:443 --mode mock --mock-scenario unreachable
```

The probe writes exactly one JSON line (a `DiagnosticReport`) to stdout and exits `0`
when it ran (npm prints its own header above it unless you pass `--silent`). The MCP server currently launches this same TypeScript file
through `tsx` (see `src/app/composition-root.ts`), not the compiled JavaScript file
that ADR 0007 describes. This standalone command is for operators only; agents
always go through `run_diagnostic`.
