# Help desk agent ecosystem

A deterministic help desk ticket core exposed as a Node.js MCP server
(`src/`), driven by agent definitions generated for three editor platforms —
VS Code (Copilot), Claude Code, and OpenCode. The server owns every business
rule (classification math, state transitions, redaction, remediation
safety, audit); the generated agents, commands, and the shared skill only
tell an agent which tool to call when (ADR 0003).

## What this covers, and where

| PDF requirement | Where it lives |
|---|---|
| Node.js implementation | `package.json` (`engines.node`); the whole `src/` tree |
| Three support categories (access & identity, infrastructure & local software, provisioning & permissions) | `src/tickets/domain/categories.ts`; `AGENTS.md` § Support categories |
| Classification / triage (category, severity → priority, entities: affected user, impacted service) | `triage` agent; `src/tickets/domain/priority.ts`, `src/tickets/domain/sla.ts` |
| Diagnosis & safe auto-remediation | `diagnostic` agent; `.claude/skills/connectivity-diagnostic/SKILL.md`; `src/diagnostics/` |
| Security / privacy (no plaintext credentials, tokens, secrets, PII) | `src/redaction/`; ADR 0008 |
| Escalation & auditable log | `escalation` agent; `src/audit/`; the hash-chained log under `data/` |
| Clear user communication | `AGENTS.md` § Communication rules; each generated agent's own Rules section |
| §2.1 custom instructions for the ticket lifecycle | `AGENTS.md` (read by VS Code and OpenCode natively; `CLAUDE.md` points Claude Code at it) |
| §2.2 agent skill with an auxiliary script | `.claude/skills/connectivity-diagnostic/`; `scripts/connectivity-probe.ts` (ADR 0007) |
| §2.3 ≥2 agents, explicit tools, delegation, acyclic handoffs | `.claude/agents`, `.github/agents`, `.opencode/agents`; `tools/generator/definitions/agents.ts`; acyclic-graph proof in `src/architecture.test.ts` and `tools/generator/validate.ts` |
| §2.4 parameterized prompt files with variables and tool invocation | `.github/prompts/*.prompt.md` (`${input:var}`), `.claude/commands/*.md`, `.opencode/commands/*.md` (`$ARGUMENTS`) |

## Architecture

Hexagonal architecture per capability (`domain` / `application` / `ports` /
`infrastructure`), organized by business capability, not by technical layer
(Screaming Architecture, ADR 0004):

```
src/
├── tickets/      domain, application, ports, infrastructure
├── diagnostics/  domain, application, ports, infrastructure
├── audit/        domain, application, ports, infrastructure
├── redaction/    domain, ports, infrastructure
├── shared/       cross-cutting kernel (Result, ids, domain-error, ports)
└── app/          composition root, MCP server, config (ADR 0013)
```

```
 VS Code (Copilot)    Claude Code          OpenCode
 .github/agents       .claude/agents       .opencode/agents
 .github/prompts      .claude/commands     .opencode/commands
 .vscode/mcp.json     .mcp.json            opencode.json
        \                   |                    /
         \                  |                   /
          v                 v                  v
              MCP stdio server "helpdesk"
              (src/app/mcp — 7 tools, one per business action)
                            |
        +-------------------+--------------------+
        v                   v                    v
  src/tickets          src/diagnostics       src/audit
  (lifecycle, SLA,     (probe runner,        (append-only,
   priority)            remediation)          hash-chained)
        \                   |                   /
         +---------- src/redaction, src/shared -+

  tools/generator/definitions --[generate]--> the three
  platform trees above (committed, drift-tested).
  .claude/skills/ is hand-written and shared unmodified across all three.
```

The generator (`tools/generator`) reads one set of typed definitions and
renders each platform's format, so a tool rename or a new agent only needs
one edit (ADR 0009). Nothing under a generated platform directory
(`.claude/agents`, `.claude/commands`, `.github/`, `.opencode/`, `.mcp.json`,
`opencode.json`, `.vscode/mcp.json`) is hand-edited — see
[Generator workflow](#generator-workflow).

## Requirements

- Node.js `>=22.12.0` (see `package.json`).

## Setup

```sh
npm install
```

Environment variables (all optional; the server runs with defaults). There
is no committed `.env.example` in this repository — set these directly, for
example in a local untracked `.env` loaded by your shell or MCP client:

| Variable | Default | Notes |
|---|---|---|
| `HELPDESK_DATA_DIR` | `data` | Where `tickets.json` and `audit.jsonl` are written. |
| `HELPDESK_PROBE_MODE` | `mock` | `mock` reproduces every probe outcome offline (reachable, degraded, unreachable, hang, crash, malformed) without touching a network. Set to `real` to actually connect. |
| `HELPDESK_PROBE_TIMEOUT_MS` | `3000` | Probe timeout in milliseconds. |
| `HELPDESK_SERVICE_CATALOG` | `config/service-catalog.json` | Which services/hosts a diagnostic may probe. |
| `HELPDESK_PSEUDONYM_KEY` | a built-in dev key | HMAC key used to pseudonymize `affectedUser` (ADR 0008). Unset → one stderr warning per process and a `config.warning` audit entry; set a real secret before any non-local use. |

## Per-platform usage

### VS Code (GitHub Copilot)

- Agents: `.github/agents/*.agent.md` (native `handoffs`) **and**
  `.claude/agents/*.md` — VS Code reads both trees, so each agent name can
  appear twice in its agent picker.

  > **Use the `.agent.md` ones.** Only `.github/agents/*.agent.md` carries
  > the native declarative `handoffs` this platform supports; the
  > `.claude/agents/*.md` copies exist for Claude Code and rely on a
  > prompt-driven `HANDOFF:` line instead.

- Prompts: `.github/prompts/*.prompt.md` (e.g. `/new-ticket`, invoked with a
  free-text `${input:description}`).
- MCP: `.vscode/mcp.json` prompts for `HELPDESK_PSEUDONYM_KEY` via its
  `inputs` block the first time the server starts, instead of reading it
  from the environment.

### Claude Code

- Agents: `.claude/agents/*.md` (subagents; no declarative handoffs — each
  ends its reply with a `HANDOFF: <target> ticket=<id>` line instead).
- Commands: `.claude/commands/*.md`, including `/helpdesk-run`, which drives
  the full `triage → diagnostic|escalation → …` sequence from the main
  session by reading each subagent's `HANDOFF:` line.
- MCP: `.mcp.json` reads `HELPDESK_PSEUDONYM_KEY` from the environment.

### OpenCode

- Agents: `.opencode/agents/*.md`, plus a generated `helpdesk-orchestrator`
  primary agent whose `permission.task` allows delegating only to the
  helpdesk subagents (`triage`, `diagnostic`, `escalation`) and denies
  everything else.
- Commands: `.opencode/commands/*.md` (`$ARGUMENTS` / `$1`).
- MCP: `opencode.json` reads `HELPDESK_PSEUDONYM_KEY` from the environment.

## Demo scenario: a VPN ticket end to end

1. **Triage.** `/new-ticket "I can't connect to the VPN from home"` (or the
   `triage` agent directly). It calls `create_ticket`, classifies the
   ticket (`infrastructure-software` / `vpn`, an affected user, impacted
   service `vpn-gateway`), and moves it to `Triaged`. The server computes
   priority and SLA dates.
2. **Diagnostic.** Handed off with only the ticket id. The `diagnostic`
   agent moves the ticket to `InProgress`, then follows
   `.claude/skills/connectivity-diagnostic/SKILL.md`: it calls
   `run_diagnostic({ ticketId, actor: "diagnostic", probe: "connectivity" })`,
   which runs the mock connectivity probe against the catalogued
   `vpn-gateway` target (`HELPDESK_PROBE_MODE=mock` by default — no real
   network call, but every branch of the contract is exercised).
3. **Branch.**
   - If the mock run decides `remediate`, the agent calls
     `apply_remediation`, the server applies the allowlisted fix and moves
     the ticket to `PendingUserConfirmation`, and the agent asks the user to
     confirm. A confirmed, fresh re-check resolves the ticket
     (`basis: "user-confirmed"`).
   - If the run decides `escalate` (nothing safe to auto-fix, or the probe
     itself failed), the agent transitions the ticket to `Escalated` with a
     reason such as `service_unreachable` and target `network-team`, then
     hands off to `escalation`, which confirms the routing and tells the
     user which team owns the case.
4. Every step above is redacted before storage and appended to the
   `audit.jsonl` hash chain under `data/` — nothing is silent.

## Generator workflow

The generated platform files are committed, but never hand-edited:

1. Edit the shared definitions in `tools/generator/definitions/` (agents,
   prompts, or the MCP server entry).
2. `npm run generate` — renders all three platforms' files.
3. `npm run generate:check` — fails if the committed output would differ
   from what `generate` would produce (repo-drift guard, ADR 0009).

## Testing

```sh
npm test        # vitest run — unit, contract, snapshot and drift tests
npm run typecheck
npm run build   # tsc -p tsconfig.build.json
```

## Data files

Runtime state lives under `data/` (gitignored, created on first run):

- `tickets.json` — the ticket store.
- `audit.jsonl` — an append-only, hash-chained audit log; each line's hash
  covers the previous line, so a deleted or edited entry breaks the chain.

## Known limitations

- The MCP server and the connectivity probe currently run through `tsx`
  directly from TypeScript source (`npx tsx src/app/mcp/main.ts`), so
  `tsx` and `typescript` must stay `devDependencies` rather than moving to
  the compiled `dist/scripts/connectivity-probe.js` path ADR 0007 describes.
  Aligning the runtime launch path with that ADR is a pending follow-up.
- Two tests in
  `src/diagnostics/infrastructure/child-process-diagnostic-runner.test.ts`
  (`output_too_large`) fail on Node v24.18 in this environment; every other
  test passes.
- `actor` on every tool call is self-declared by the calling agent — MCP
  has no caller identity in this MVP (ADR 0010). Mitigated, not prevented,
  by per-agent tool lists (an agent literally cannot call a tool it was not
  generated with) and the audit trail.
- Claude Code and OpenCode have no native declarative handoff mechanism;
  their agent-to-agent flow is prompt-driven (a `HANDOFF:` line an
  orchestrator reads), with correctness guaranteed server-side — the MCP
  server rejects any transition the acting role may not perform regardless
  of what the prompt-driven handoff claims (ADR 0003, ADR 0009).

## Architecture decisions

See [`docs/adr`](docs/adr/README.md) for the full log, including the three
platforms and file-format survey (0002), the MCP-server-as-deterministic-core
decision (0003), hexagonal/screaming layout (0004), the redaction strategy
(0008), the generator design (0009), and actor-scoped transitions (0010).
