# 0006. Development workflow: ODD + SDD + Strict TDD

- Status: Accepted
- Date: 2026-09-23

## Context

This project needs a development workflow that is both traceable (for a technical-test reviewer) and disciplined at the implementation level, without introducing artifacts that don't fit the repository's greenfield state (a single PDF and a tooling folder at the start).

## Decision

- **Organic Driven Development (ODD)** is the overall flow for the whole project.
- **Spec-Driven Development (SDD)** is the selected route for this change: explore → proposal → spec → design → tasks → apply → verify → archive, run at an interactive pace.
- **Strict TDD** (RED → GREEN → REFACTOR) applies inside each implementation task, once the vitest scaffold (ADR 0005) exists. The first implementation task is that scaffold itself.
- **SDD artifact storage**: by user choice, SDD artifacts (proposal, spec, design, tasks) are stored in Engram only, not as files in the repository. Consequence: the native SDD dispatcher (which defaults to `openspec`) does not track progress against repo files; phase state is read from Engram instead.
- **Delivery**: pull requests auto-chain once a change accumulates roughly 400 changed lines.

## Alternatives considered

*(Not applicable — this ADR records a workflow choice already made for the project rather than a decision with rejected code-level alternatives; see ADR 0001 for how future workflow-relevant decisions from the SDD design phase are recorded.)*

## Consequences

**Positive**

- The implementation trail is fully reconstructable from Engram even though no SDD artifact files live in the repo.
- Strict TDD starting from an explicit scaffold task avoids "TDD in theory, ad hoc in practice" drift.
- Auto-chaining PRs at ~400 lines keeps individual review slices scannable.

**Negative**

- SDD progress is not visible by browsing the repository alone (no `openspec`-tracked files); anyone auditing the change history needs Engram access to see phase-by-phase state.
- The native SDD dispatcher's own progress tracking is effectively bypassed, so tooling built against that dispatcher's default (`openspec`-backed) state will not reflect reality here.
