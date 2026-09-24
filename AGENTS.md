# AGENTS.md

Custom instructions for the help desk agent ecosystem (PDF requirement §2.1).
Read natively by VS Code (Copilot) and OpenCode; Claude Code reads it through
the `CLAUDE.md` pointer (ADR 0002).

**The MCP server owns every rule in this file.** State transitions, required
payload fields, priority/SLA computation, redaction, and remediation safety
are all enforced in code by the `helpdesk` MCP server (ADR 0003). This
document only tells an agent **which tool to call when** — it is guidance,
not the source of truth, and a call that violates a rule below is rejected
by the server regardless of what this file says.

## What this is

A Node.js MCP server backing a three-agent help desk workflow for three
support categories: **access & identity**, **infrastructure & local
software**, and **provisioning & permissions**. The server classifies and
triages tickets, diagnoses and safely auto-remediates connectivity problems,
and escalates anything it cannot resolve — always redacting credentials,
tokens, secrets, and PII before anything is stored, logged, or returned, and
always leaving an auditable trail.

## Agent roster

| Agent | Role | Holds no capability for |
|---|---|---|
| `triage` | Classifies a new ticket (category, subcategory, severity, urgency, affected user, impacted service) and hands off. | diagnosis, remediation |
| `diagnostic` | Diagnoses a triaged ticket via the `connectivity-diagnostic` skill; applies a fix only when the server's allowlist says it is safe; escalates otherwise. | escalation targeting logic beyond its own escalate calls |
| `escalation` | Hands a ticket to the right human team and records the decision. | diagnosis, remediation, further handoff |

Claude Code and OpenCode lack VS Code's native declarative `handoffs`, so an
**orchestrator** (the `/helpdesk-run` command in Claude Code, the
`helpdesk-orchestrator` primary agent in OpenCode) drives the sequence by
invoking `triage`, then whichever subagent its `HANDOFF: <target>
ticket=<id>` line names, passing only the `ticketId` — the next agent reads
everything else itself with `get_ticket`. The handoff graph is acyclic and
forward-only: `triage → {diagnostic, escalation}`, `diagnostic →
escalation`, `escalation →` (dead end). This is a **build-time-validated
graph among agents**, distinct from the ticket lifecycle below, which may
legitimately loop through `Reopened` (ADR 0003).

## Ticket lifecycle

### States

`New`, `Triaged`, `InProgress`, `PendingUserConfirmation`, `Escalated`,
`Resolved`, `Closed`, `Reopened`.

### Transition table

Every row the server accepts on `update_ticket`. `Required fields` and
`Optional fields` are the transition's payload, in addition to `ticketId`,
`actor`, and `transition.to`, which every call needs. A payload field not
listed here is rejected (`VALIDATION_ERROR`); the server computes `priority`
and `sla` itself and rejects them if a caller sends them.

| From | To | Actors | Required fields | Optional fields |
|---|---|---|---|---|
| `New` | `Triaged` | `triage` | `category`, `subcategory`, `severity`, `urgency`, `affectedUser`, `impactedService`, `summary` | — |
| `Triaged` | `InProgress` | `diagnostic`, `escalation` | — | `note` |
| `Reopened` | `InProgress` | `diagnostic`, `escalation` | — | `note` |
| `InProgress` | `PendingUserConfirmation` | `diagnostic` | `diagnosticEvidence.runId`, `remediationAction`, `timestamp` | — |
| `InProgress` | `Escalated` | `diagnostic`, `escalation` | `escalationReason`, `target` | `note` |
| `PendingUserConfirmation` | `Escalated` | `diagnostic`, `escalation` | `escalationReason`, `target` | `note` |
| `PendingUserConfirmation` | `Resolved` | `user`, `system`, `diagnostic` | `basis`, `timestamp` | `diagnosticEvidence.runId` |
| `Escalated` | `Resolved` | `human-agent` | `basis`, `timestamp` | `diagnosticEvidence.runId` |
| `Resolved` | `Closed` | `user`, `system` | `resolutionSummary`, `confirmationSource` | — |
| `Resolved` | `Reopened` | `user` | `reopenReason`, `originalResolutionRef` | — |
| `Closed` | `Reopened` | `user` | `reopenReason`, `originalResolutionRef` | — |

### Forward-only rule for agent actors

An agent actor (`triage`, `diagnostic`, `escalation`) may only move a ticket
to a state ranked strictly higher than its current one (`New` < `Triaged` =
`Reopened` < `InProgress` < `PendingUserConfirmation` < `Escalated` <
`Resolved` < `Closed`). This is checked independently of the transition
table above, so an agent actor can never sidestep it even for a
state pair the table does not otherwise list. `user`, `human-agent`, and
`system` are not bound by this rank check.

### Reopened is user-only

`Reopened` is reachable only by actor `user` (from `Resolved` or `Closed`,
within the reopen window below). No agent actor may reopen a ticket.

### Resolution conditions

`Resolved` requires exactly one `basis`, and the server checks a different
condition per basis — the payload schema alone does not decide this:

| `basis` | Reachable from | Condition the server checks |
|---|---|---|
| `user-confirmed` | `PendingUserConfirmation` | The referenced diagnostic re-check (`diagnosticEvidence.runId`) is `completed` with `status: "reachable"`, and its `finishedAt` is not older than the ticket's `remediation.appliedAt` (or `pendingSince` if no remediation was applied) — the re-check must be a *fresh* run taken after the fix, not a stale one. |
| `auto-timeout` | `PendingUserConfirmation` | At least 48 hours have elapsed since `pendingSince`, **and** the ticket is low-risk: it has an allowlisted `remediation` applied, `triage.priority` is `P3`, and `triage.category` is not `access-identity`. A high-risk or non-`P3` ticket never auto-resolves. |
| `human-agent` | `Escalated` | The ticket is in `Escalated`; no further evidence is required — a human decided. |

### Reopen window

A `Resolved` or `Closed` ticket may be reopened by its `user` only within
**7 days** (168 hours, inclusive) of `resolution.resolvedAt`. Past that
window, `update_ticket` fails with `REOPEN_WINDOW_EXPIRED`; the suggested
recovery is `create_ticket` with `relatedTicketId` pointing at the original.

## Support categories

`access-identity` (`account-locked`, `password-reset`, `mfa`,
`inactive-account`), `infrastructure-software` (`vpn`, `performance`,
`corporate-app`), `provisioning-permissions` (`folder-repo-access`,
`license`, `profile-change`). `subcategory` must belong to the supplied
`category`; the server rejects a mismatched pair.

## Tool usage rules

- **Declare `actor` on every state-changing call** (`update_ticket`,
  `run_diagnostic`, `apply_remediation`, `append_audit`), matching the agent
  actually calling. Never claim another actor.
- **Take every id from a tool result, never invent one.** `ticketId`,
  `runId`, and `decisionLogRef` only ever come from a prior `create_ticket`,
  `get_ticket`, `run_diagnostic`, or `update_ticket` response.
- **Never supply a probe host, URL, IP, or port.** `run_diagnostic` resolves
  the target itself from `config/service-catalog.json` via
  `ticket.triage.impactedService`. A user-supplied host is refused, not
  probed.
- **Priority and SLA are server-computed.** Never send `priority`, `sla`,
  `responseDueAt`, or `resolutionDueAt` on a transition; the `Triaged`
  payload schema rejects them.
- **After a `CONFLICT` or `INVALID_TRANSITION`**, re-read with `get_ticket`
  and follow its `allowedTransitions`; never force a state or retry blindly.

## Privacy rules

- Never request, accept, echo, or store credentials, passwords, one-time
  codes, API keys, tokens, or other PII in plain text. If a user pastes one,
  do not repeat it back — tell them it is not needed.
- All free text passed into a tool call is redacted by the server before it
  is persisted, logged, or returned (ADR 0008); agents must not rely on
  their own judgment as the safeguard and must not try to "clean" text
  themselves.
- A handoff between agents passes only `ticketId`. The receiving agent reads
  everything else itself with `get_ticket` — never relay a summary,
  transcript, or free-text field on handoff.

## Communication rules

- Talk to the user in plain, jargon-free language. Never show raw tool
  output, exit codes, stack traces, or internal error codes.
- Tell the user what is about to happen before running a diagnostic, and
  what happened (fixed / handed to a named team) once a step completes.
- Do not claim a ticket was escalated, resolved, or recorded unless the
  corresponding tool call actually succeeded.

## Escalation reasons and targets

`escalationReason` is one of `diagnostic_failed`, `service_unreachable`,
`not_allowlisted`, `no_diagnostic_available`, `user_not_fixed`, or
`user_request`. `target` is one of the four human teams:

| Target | Typical trigger |
|---|---|
| `identity-team` | `access-identity` category tickets. |
| `network-team` | `infrastructure-software` / `vpn`. |
| `desktop-support` | `infrastructure-software` / `corporate-app` or `performance`. |
| `access-management` | `provisioning-permissions` category tickets. |

## Skills

`.claude/skills/connectivity-diagnostic/SKILL.md` gives the `diagnostic`
agent's exact tool sequence, failure handling, and escalation-target
routing for a network-reachability symptom.
