# 0015. Probe launcher precedence (built JS preferred, tsx fallback)

- Status: Accepted
- Date: 2026-09-24

## Context

ADR 0007 calls for the connectivity probe to be invoked as
`node dist/scripts/connectivity-probe.js`. In practice, the
`ChildProcessDiagnosticRunner` (slice 5, feature branch
`feat/helpdesk-12-connectivity-skill`) was implemented to always
spawn `node <tsxBinPath> <scriptPath>` against the TypeScript source
so a hung dev workflow without `npm run build` would still work. The
slice-5 review deferred the alignment to this ADR. As long as the
runtime diverges from ADR 0007, `prepare` produces an artifact the
runtime never consumes, and `tsx` / `typescript` cannot move from
`devDependencies` to `dependencies` (the runtime needs them).

## Decision

Add a thin resolver, `resolveProbeLaunch(packageRoot)`
(`src/diagnostics/infrastructure/probe-launcher.ts`), that returns
one of two shapes:

| Mode | Trigger | `scriptPath` | `tsxBinPath` |
|---|---|---|---|
| `built` | `dist/scripts/connectivity-probe.js` exists in `packageRoot` | the `.js` path | absent |
| `tsx` | otherwise (no build artifact, fresh checkout, partial build) | `scripts/connectivity-probe.ts` | `node_modules/.bin/tsx` |

`ChildProcessDiagnosticRunnerOptions.tsxBinPath` becomes optional.
When omitted, `spawn()` invokes `node <scriptPath>` directly (built
shape); when present, the previous
`node <tsxBinPath> <scriptPath>` shape is preserved (dev shape). The
composition root uses `resolveProbeLaunch(config.packageRoot)` to
pick the shape once at startup, so the MCP server and any future
script (e.g. `npm run probe`) can follow the same precedence.

`npm run probe` keeps its current behaviour (`tsx scripts/connectivity-probe.ts`)
so day-to-day dev use is unaffected. A `probe:built` script can be
added later if an operator wants to force the built path explicitly.

## Alternatives considered

- **Force the built path always; fail the server if `dist/` is missing** —
  rejected: a fresh checkout cannot start the server without running
  `npm run build` first, and `tsx` would no longer be a runtime
  dependency. The current fallback keeps the dev loop zero-step.
- **Auto-build on first MCP server start** — rejected: makes
  `build` a runtime side effect, which complicates CI (the test
  runner should not need to compile) and surprises operators who
  expected a pure consumer of `prepare`'s output.
- **Ship a separate `probe` binary per platform (pkg, nexe)** —
  rejected: ADR 0003 already accepts Node as the runtime; bundling
  duplicates what `prepare` already does.

## Consequences

**Positive**

- ADR 0007's runtime path is what the server actually uses.
- A single artifact check (`dist/scripts/connectivity-probe.js`)
  decides production vs dev: no `NODE_ENV` branching, no
  hand-maintained flag.
- The composition root stays pure (one call to
  `resolveProbeLaunch`); the runner stays a dumb adapter.

**Negative**

- A partial build (`dist/` exists but the probe file inside is
  stale or missing) silently falls back to tsx. The resolver logs
  `mode: "tsx"` so an operator can see it, but no warning is
  emitted to stderr. Adding a stderr warning is a small follow-up
  if it becomes a real operational confusion source.
- `tsx` and `typescript` still need to stay in `devDependencies`
  for the dev path to work. If/when the project drops the tsx
  fallback (e.g. a future commit insists on `prepare` before
  start), this ADR is the one to revisit.