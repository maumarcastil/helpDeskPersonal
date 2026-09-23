# 0007. Diagnostic script contract

- Status: Accepted
- Date: 2026-09-23

## Context

Requirement 2.2 asks for a diagnostic skill that consumes a functional auxiliary script and handles the case where the script does not respond. The MCP server (ADR 0003) runs that script through a `child_process` adapter (ADR 0004). Without an explicit contract, "the script failed" and "the script ran and found a problem" become indistinguishable, and a hung or compromised script could block the server or leak data.

## Decision

The connectivity probe (`scripts/connectivity-probe.ts`, built to `dist/scripts/connectivity-probe.js`) follows a fixed contract:

- **Invocation**: `node dist/scripts/connectivity-probe.js --target <tcp://host:port | http(s)://host[:port]/path> --timeout-ms <100..10000> [--mode real|mock] [--mock-scenario reachable|unreachable|degraded|hang|crash|malformed]`. Environment fallbacks: `HELPDESK_PROBE_MODE`, `HELPDESK_PROBE_MOCK_SCENARIO`; argv wins.
- **Stdout**: exactly one JSON object (single line, at most 64 KiB) matching `DiagnosticReport` schema version 1: `schemaVersion`, `probe: "connectivity"`, `mode`, `target`, `status: reachable|degraded|unreachable`, `checks[]` (`dns|tcp|http`, `ok`, `latencyMs`, optional `detail`), `startedAt`, `finishedAt`. Nothing else is written to stdout; diagnostics go to stderr.
- **Exit codes**: `0` = the probe ran and the verdict is in the payload (an unreachable target is still exit 0); `2` = usage error; `3` = internal error; anything else = crash.
- **Runner**: spawns `process.execPath` with a fixed script path and an argv array (`shell: false`), passes a minimal environment (no inherited secrets), kills the child with `SIGKILL` after `timeoutMs + 1000 ms`, and validates stdout with zod. Timeout, non-zero exit, spawn error, oversize output, or schema-invalid output all become a typed `RunnerFailure`.
- **Fail closed**: any `RunnerFailure` is audited and returns an `escalate` decision; no remediation or resolution can reference a failed run.
- **Targets**: the model never supplies a host. The server resolves the probe target from the ticket's `impactedService` through a committed service catalog (`config/service-catalog.json`).
- **Mock mode** reproduces every outcome, including hang, crash, and malformed output, so the full failure path is demonstrable offline and covered by contract tests.

## Alternatives considered

- **In-process probe (no script)** — rejected: requirement 2.2 explicitly asks for an auxiliary script, and the failure-handling path (non-responsive script) would not exist.
- **Exit code carries the verdict (non-zero = unreachable)** — rejected: conflates "probe crashed" with "service down"; a crash must escalate for a different reason than an outage.
- **Model-supplied target host** — rejected: turns the probe into an SSRF primitive driven by untrusted ticket text.

## Consequences

**Positive**

- Every failure mode has one deterministic, tested outcome (escalation plus audit entry).
- The script is usable standalone by the skill and by humans, with the same contract.

**Negative**

- The script must be built (`npm run build`, also run by `prepare`) before the server can use it.
- Adding a new probe target requires editing the service catalog, not just the ticket text.
