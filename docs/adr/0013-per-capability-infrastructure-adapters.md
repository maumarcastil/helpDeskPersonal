# 0013. Per-capability infrastructure adapters

- Status: Accepted
- Date: 2026-09-23

## Context

ADR 0004 placed every adapter implementation in a single, global `src/infrastructure/`, grouped by technology rather than by capability. In practice this meant `src/infrastructure/crypto/` mixed the audit capability's `NodeSha256Hasher` with the redaction capability's `HmacPseudonymizer`, even though the two have nothing to do with each other beyond both calling into `node:crypto`. That technical grouping is exactly what Screaming Architecture argues against: a reviewer looking for "how redaction works" has to search two trees (`src/redaction/` and `src/infrastructure/crypto/`) instead of one, and a change scoped to a single capability (e.g. swapping the audit hasher) touches a folder shared with unrelated capabilities.

## Decision

Each capability owns its adapters in `src/<capability>/infrastructure/`, alongside that capability's existing `domain/`, `application/`, and `ports/`. There is no more global `src/infrastructure/`.

- Cross-cutting bootstrapping — the composition root, config loading, the MCP server driving adapter, and `main` — lives in `src/app/`, since it wires capabilities together rather than belonging to any one of them. `src/app/` does not exist yet; it is documented here so the boundary is decided before the first bootstrapping file is written.
- `src/shared/` never holds adapters. `shared/domain` and `shared/ports` are imported by every capability's domain, so an adapter placed there would give every domain a transitive path to infrastructure — exactly the leak ADR 0004's hexagonal boundary exists to prevent. Cross-capability technical helpers that are themselves adapters (e.g. a system clock, a crypto-backed ID generator) belong in `src/app/`, not `src/shared/`.
- `src/architecture.test.ts` enforces the boundary: infrastructure-only Node builtins (`node:crypto`, `node:fs`, `node:child_process`, `node:net`, `node:dns`, `node:http`, `node:https`) may only be imported under a capability's `infrastructure/**` or under `src/app/**`; `domain/` and `application/` never import any `infrastructure/` path; `src/shared/` never imports a capability's `infrastructure/`.

## Alternatives considered

- **Keep the global `src/infrastructure/`, grouped by technology** — rejected: this is the status quo being corrected. It groups by *how* something is implemented (crypto, filesystem, process) instead of *what business capability* it serves, so a single-capability change touches two trees and the folder becomes a shared dependency across otherwise-independent capabilities.
- **Put shared adapters in `src/shared/`** — rejected: `src/shared/domain` and `src/shared/ports` are the most-depended-on module in the codebase (every capability's domain imports them). Allowing adapters there opens a path for infrastructure to reach the domain layer through the one import every domain file already trusts, destabilizing the module the domain purity rules (ADR 0011, ADR 0012) are built to protect.

## Consequences

**Positive**

- Each capability is self-contained: `src/<capability>/` holds its domain, application, ports, and infrastructure together, with nothing about that capability living outside its own folder.
- "All technical/adapter code" is still trivially discoverable via the `src/*/infrastructure/` glob, without a global folder.
- The architecture test enforces the boundary structurally (confined builtins, no domain/application/shared import of `infrastructure/`), so a regression fails `npm test`, not just review.

**Negative**

- No single folder answer to "where do I add a new technical dependency" anymore; a contributor must first identify which capability the adapter serves (or that it is truly cross-cutting and belongs in `src/app/`).
- `src/app/` did not exist before this ADR and is not yet populated; the boundary it documents (composition root, config, MCP driving adapter, `main`) is a placeholder until that bootstrapping work happens.
