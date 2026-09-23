# 0001. Record architecture decisions

- Status: Accepted
- Date: 2026-09-23

## Context

This repository is the deliverable for a technical test (`Prueba_Tecnica_Ecosistema_Agentes_HelpDesk.pdf`): a help desk agent ecosystem built with editor agent customization across multiple platforms. A reviewer needs to see *why* each structural choice was made, not just the resulting files. Decisions will also keep arriving in stages — first a batch made up front (this set), then further decisions produced during the SDD design phase of the workflow.

## Decision

Use Architecture Decision Records (ADRs) in `docs/adr/`, one Markdown file per decision, following a lightweight MADR format (Context / Decision / Alternatives considered / Consequences). Decisions produced later by the SDD design phase are appended as new, sequentially numbered ADRs rather than folded into existing ones.

## Alternatives considered

- **No written record, rely on commit messages and code comments** — rejected: a reviewer would have to reconstruct rationale and rejected alternatives from diffs, which is exactly the cognitive load ADRs exist to remove.
- **A single running `DECISIONS.md` log** — rejected: it does not scale to distinguish status changes (e.g. a decision later superseded) and makes reviewing one decision in isolation harder.

## Consequences

**Positive**

- Reviewers can audit the rationale behind the architecture without reading through implementation code.
- Later SDD-phase decisions have an obvious, consistent place to land.

**Negative**

- Adds bookkeeping: every meaningful decision now needs a dedicated file kept up to date (status changes, superseding records).
