# 0004. Hexagonal architecture with Screaming organization and SOLID

- Status: Accepted
- Date: 2026-09-23
- Amended by: 0013 (adapter placement)

## Context

The MCP server (ADR 0003) has real, structural variation on three axes: three consumer platforms, multiple diagnostic mechanisms, and a storage layer that may change. The codebase needs a structure that makes the domain (help desk business rules) visible on its own terms, keeps that domain independent of any specific platform or storage choice, and avoids speculative infrastructure the test does not call for.

## Decision

Use Ports & Adapters (hexagonal architecture) combined with Screaming Architecture folder organization, applying SOLID where there is real variation:

- **Hexagonal boundary**: the MCP server is a driving adapter. Driven adapters: a JSON-file ticket repository, a JSONL append-only audit log, and a `child_process`-based diagnostic runner with timeout and explicit failure handling.
- **Screaming organization**: folders are grouped by business capability — `src/tickets`, `src/diagnostics`, `src/audit`, each containing its own `domain/`, `application/`, and `ports/` — plus a separate `src/infrastructure` for adapter implementations. Hexagonal governs the *direction* of dependencies; Screaming governs how folders are *grouped*; the two are complementary, not competing.
- **SOLID**, applied specifically where variation is real: notably Dependency Inversion — use cases receive ports through their constructor, wired together in a hand-written composition root (no DI container).
- Agent/skill/prompt Markdown files sit **outside** the hexagon: they configure clients of the MCP adapter, not the domain itself.
- The per-platform generator (ADR 0002) lives in `tools/generator`, a separate build-time context, using a Strategy renderer per target platform and validating that the handoff graph is acyclic before emitting any files.
- **Explicitly out of scope**, to avoid over-engineering: a DI container, a database, and event sourcing/CQRS.

## Alternatives considered

- **Layered by technical type (controllers/services)** — rejected: hides the domain behind technical layering; a reviewer looking for "how tickets are prioritized" would have to search across controller, service, and repository layers instead of one `src/tickets` folder.
- **No architecture, flat scripts** — rejected: the test's core challenge is serving multiple, structurally different platform entry points against one deterministic core — exactly the problem ports & adapters is designed to solve; flat scripts would re-couple platform concerns to business logic.

## Consequences

**Positive**

- The domain (`tickets`, `diagnostics`, `audit`) is immediately visible in the folder tree, independent of framework or platform concerns.
- Swapping the ticket store (e.g. JSON file → database) or the diagnostic mechanism touches only `src/infrastructure`, not use cases.
- The generator's acyclic-handoff validation happens at build time, catching a broken handoff graph before it reaches any platform.

**Negative**

- More upfront structure (ports, use cases, composition root) than a flat script for a test-scoped project — justified here specifically by the three-platform and multi-adapter variation, not applied elsewhere.
- Wiring is hand-written (no DI container), so the composition root must be kept in sync manually as new ports are added.
