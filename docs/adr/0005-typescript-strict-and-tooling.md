# 0005. TypeScript (strict) and tooling

- Status: Accepted
- Date: 2026-09-23

## Context

ADR 0004 defines ports as the contract between the domain and its adapters (JSON-file repository, JSONL audit log, `child_process` diagnostic runner, three platform consumers). In plain JavaScript, those contracts (and the Liskov Substitution / Interface Segregation properties they depend on) exist only by convention — nothing stops an adapter from silently drifting from its port's shape.

## Decision

Node.js LTS with TypeScript in strict mode, plus:

- `@modelcontextprotocol/sdk` — MCP server implementation.
- `zod` — validates MCP tool input and LLM-extracted ticket data at the boundary.
- `vitest` — test runner.
- `tsc` — build.
- `tsx` — development execution.

Ports become real TypeScript `interface`s, so the compiler — not convention — enforces that every adapter satisfies its contract.

## Alternatives considered

- **Plain JavaScript** — rejected: no compile-time contract checking; a port/adapter mismatch would only surface at runtime, defeating the purpose of defining ports in ADR 0004.
- **`node:test`** — rejected: requires an extra TypeScript loader and has weaker developer experience for the Strict TDD workflow (ADR 0006) compared to vitest's built-in TS support and watch mode.

## Consequences

**Positive**

- Adapter/port mismatches are caught at compile time, not discovered in production or in a test run.
- `zod` schemas give a single, explicit validation point for data crossing the LLM → deterministic-core boundary (ADR 0003).
- `vitest` gives fast, TS-native RED/GREEN feedback for the Strict TDD workflow.

**Negative**

- Adds a build step (`tsc`) before the server can run in production, versus executing JavaScript directly.
- Strict mode adds upfront friction (explicit typing, no implicit `any`) compared to plain JS or loose TypeScript.
