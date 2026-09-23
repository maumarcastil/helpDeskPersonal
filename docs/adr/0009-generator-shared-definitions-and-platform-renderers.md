# 0009. Generator: shared definitions and platform renderers

- Status: Accepted
- Date: 2026-09-23

## Context

ADR 0002 requires agents, prompt files/commands, and MCP configuration for VS Code, Claude Code, and OpenCode from one source of truth; ADR 0004 places the generator in `tools/generator` with a Strategy renderer per platform. The platforms differ in tool naming, variable syntax, delegation mechanism, and file locations, and only VS Code has declarative handoffs.

## Decision

- **Shared definitions** are typed TypeScript modules in `tools/generator/definitions/` (agents, prompts, MCP server), parsed by zod. Agents declare abstract capabilities (`ticket.read`, `diagnostic.run`, …), never platform tool names. Prompts use a neutral `{{param}}` template syntax; a prompt has either one free-text parameter or only single-token parameters.
- **Validation before emit**: unique kebab-case ids, known handoff and prompt targets, no self-loops, acyclic handoff graph (DFS with cycle path in the error), and role capability rules (triage cannot hold `diagnostic.run` or `remediation.apply`). Any failure aborts the build with no files written.
- **Renderers** implement `PlatformRenderer.render(model): RenderedFile[]` and are pure. Capabilities map to `helpdesk/<tool>` (VS Code), `mcp__helpdesk__<tool>` (Claude Code), and `helpdesk_<tool>` (OpenCode); MCP tool names come from the server's `TOOL_NAMES` constant.
- **Handoff emulation**: VS Code gets native `handoffs`. Claude Code subagents end with a `HANDOFF: <agent|none> ticket=<id>` line and the generated command drives the sequence from the main session, bounded by the graph's longest path. OpenCode gets a generated primary `helpdesk-orchestrator` agent whose `permission.task` allows only the helpdesk subagents; subagents have `task` denied. In all platforms the MCP server rejects transitions the acting role may not perform (ADR 0010).
- **Generated files are committed**; `npm run generate:check` and a vitest test fail when committed output drifts from the definitions.

## Alternatives considered

- **Handlebars/EJS templates per platform** — rejected: logic (tool mapping, graph-derived text) would move into untyped templates.
- **One platform as source, converting to the others** — rejected: VS Code's format has concepts (native handoffs) the others lack, so the conversion would be lossy and asymmetric.
- **Generate at install time only** — rejected: reviewers could not browse the platform files in the repository.

## Consequences

**Positive**

- A cycle, an unknown agent, or a mis-scoped triage agent is a build failure, not a runtime surprise.
- Adding a platform is one new renderer plus its tests.

**Negative**

- Claude Code and OpenCode handoffs remain prompt-driven; determinism there relies on server-side enforcement.
- Platform format drift requires renderer updates; snapshot tests only prove the output matches our understanding of each format.
