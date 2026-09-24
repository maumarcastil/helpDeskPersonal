# DiagnosticReport reference

Reference material for the connectivity-diagnostic skill. The source of truth is the
code; this page describes it and is checked against it by
`tools/skills/skills.test.ts`.

- Probe script: `scripts/connectivity-probe.ts`
- Report schema: `src/diagnostics/domain/diagnostic-report.ts`
- Runner failure reasons: `src/diagnostics/domain/runner-outcome.ts`
- Escalation reasons: `src/tickets/domain/transition-payloads.ts`
- Contract decision: `docs/adr/0007-diagnostic-script-contract.md`

## DiagnosticReport (schema version 1)

The probe writes exactly one JSON object, on a single stdout line, at most 64 KiB.
Unknown fields are rejected (strict schema).

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | `1` | Literal. |
| `probe` | `"connectivity"` | Literal. |
| `mode` | `"real"` \| `"mock"` | `mock` is the default. |
| `target` | string (≤ 256 chars) | Echo of the target the server resolved from the catalog. |
| `status` | `"reachable"` \| `"degraded"` \| `"unreachable"` | The verdict. |
| `checks` | array, 1 to 5 items | Each: `name` (`dns` \| `tcp` \| `http`), `ok` (boolean), `latencyMs` (≥ 0), optional `detail` (≤ 300 chars). |
| `startedAt` | ISO-8601 datetime | |
| `finishedAt` | ISO-8601 datetime | |

Example (mock, unreachable):

```json
{"schemaVersion":1,"probe":"connectivity","mode":"mock","target":"tcp://vpn.example.com:443","status":"unreachable","checks":[{"name":"dns","ok":false,"latencyMs":200,"detail":"ENOTFOUND"},{"name":"tcp","ok":false,"latencyMs":0,"detail":"no route"}],"startedAt":"2026-09-24T00:00:00.000Z","finishedAt":"2026-09-24T00:00:00.001Z"}
```

An `unreachable` status is a **result**, not a failure: the probe ran and the
service is down. The server then decides between remediation and escalation.

## Exit codes

| Exit code | Meaning |
|---|---|
| `0` | The probe ran; the verdict is in the report (even when `status` is `unreachable`). |
| `2` | Usage error: missing `--target`, unsupported scheme, or `--timeout-ms` outside 100..10000. No report is printed. |
| `3` | Internal error inside the probe. No report is printed. |
| anything else | Crash. The server treats it as `nonzero_exit`. |

## Mock scenarios

Selected with `--mock-scenario` (or `HELPDESK_PROBE_MOCK_SCENARIO`) when
`--mode mock` (or `HELPDESK_PROBE_MODE=mock`). Argv wins over the environment.

| Scenario | Probe behaviour | What the server reports |
|---|---|---|
| `reachable` | Exit 0, `status: "reachable"`. | Completed run; `remediate` when the ticket's category/subcategory is allowlisted, otherwise `escalate` / `not_allowlisted`. |
| `unreachable` | Exit 0, `status: "unreachable"`. | Completed run; `escalate` / `not_allowlisted`. |
| `degraded` | Exit 0, `status: "degraded"` (slow TCP check). | Completed run; `escalate` / `not_allowlisted`. |
| `hang` | No output for about 3 s, then exit 1. | `timeout` when the configured timeout plus the 1 s kill grace is shorter than the hang, otherwise `nonzero_exit`. |
| `crash` | Message on stderr, exit 1, no report. | `nonzero_exit`. |
| `malformed` | Exit 0 with a non-JSON line. | `malformed_output`. |

## Runner failure reasons

A runner failure means the probe could not produce a usable report. The server
never feeds a failure into the remediation allowlist; it always decides
`escalate` / `diagnostic_failed`.

| Reason | Cause |
|---|---|
| `timeout` | The probe was killed after the timeout plus the grace period. |
| `nonzero_exit` | The probe exited with a code other than 0 (including 2 and 3). |
| `malformed_output` | Stdout was not a valid `DiagnosticReport`. |
| `output_too_large` | Stdout exceeded 64 KiB. |
| `spawn_error` | The probe process could not be started. |

## Escalation reasons

Values accepted by `update_ticket` for `transition.escalationReason`.

| Reason | Produced by |
|---|---|
| `diagnostic_failed` | `run_diagnostic` after any runner failure. |
| `service_unreachable` | Not produced by `run_diagnostic` today; available to an agent or human escalating an outage by hand. |
| `not_allowlisted` | `run_diagnostic` when the probe ran but no allowlisted fix matches. |
| `no_diagnostic_available` | `run_diagnostic` when the impacted service has no probe in `config/service-catalog.json`. |
| `user_not_fixed` | The user reports the applied fix did not help (from `PendingUserConfirmation`). |
| `user_request` | The user explicitly asks for a human. |
