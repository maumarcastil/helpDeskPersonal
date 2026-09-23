# 0003. Deterministic core exposed as an MCP server

- Status: Accepted
- Date: 2026-09-23

## Context

Three agent platforms (ADR 0002) each drive their own LLM session against this project. Business rules that must hold regardless of which platform or model is in use — priority computation, ticket state transitions, PII redaction, safe-vs-escalate remediation decisions, audit logging — cannot be left to prompt text, because prompt-driven behavior varies per model and per platform and offers no guarantee.

## Decision

Business rules live in code, inside a Node.js MCP server, consumed identically by all three platforms. Markdown customizations (instructions, skills, agents) only tell the agent *when* to call *which* tool; they do not implement the rules themselves. Responsibility split:

- **LLM**: understand natural-language tickets, extract entities, suggest impact/urgency, write user-facing replies.
- **Code (MCP server)**: validate extracted data against schemas, compute priority from an impact × urgency matrix, enforce ticket state transitions, redact credentials/tokens/PII before persisting or logging, decide auto-remediation vs. escalation via an allowlist of safe actions, and write an append-only audit log.

Two different graphs must not be confused:

- **Agent handoff graph** (requirement 2.3): must be acyclic. The generator validates it at build time, and the server enforces that agent-driven transitions only move the ticket forward (Triage → Diagnostic & Remediation → Escalation), rejecting any transition not allowed by the lifecycle regardless of what an orchestrator attempts. This lets Claude Code and OpenCode — which lack VS Code's native declarative `handoffs` — emulate handoffs safely via an orchestrator agent calling subagents.
- **Ticket lifecycle**: may legitimately loop. `Resolved`/`Closed` → `Reopened` → `InProgress` is an explicit, user-triggered step bounded by a reopen window; it is not an agent handoff and does not violate 2.3.

## Alternatives considered

- **Rules encoded only in prompts/instructions** — rejected: non-deterministic, varies per model and per platform, and cannot guarantee security properties (PII redaction) or structural properties (acyclic agent handoffs, valid lifecycle transitions) that the test requires.

## Consequences

**Positive**

- Priority, state transitions, redaction, and remediation decisions behave identically no matter which of the three platforms or which underlying model is driving the session.
- Handoff-cycle prevention is enforced once, centrally, instead of depending on each platform's (absent or different) handoff mechanism.
- Security- and correctness-sensitive logic is testable in isolation, independent of any LLM behavior.

**Negative**

- Adds an MCP server as a runtime dependency for every platform; the ecosystem cannot function as prompts alone.
- Any new business rule must be implemented in code and released through the server rather than adjusted by editing a Markdown file.
