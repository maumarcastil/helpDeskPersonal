# Architecture Decision Records

This folder records the architecture decisions made for the help desk agent ecosystem, so a reviewer can see why a structural choice was made without reconstructing it from code. Each decision is one Markdown file, numbered sequentially and never renumbered or deleted; when a decision changes, a new ADR supersedes the old one instead of editing it away.

## Adding an ADR

1. Copy `template.md` to `NNNN-kebab-title.md`, where `NNNN` is the next number (zero-padded, e.g. `0007`).
2. Fill in Context, Decision, Alternatives considered, and Consequences.
3. Set the status:

   | Status | Meaning |
   |---|---|
   | `Proposed` | Under discussion, not yet acted on. |
   | `Accepted` | In effect. |
   | `Superseded by NNNN` | Replaced by a later ADR; keep the file, update its status. |
   | `Deprecated` | No longer applies, with no replacement. |

4. Add a row to the index below.

## Index

| # | Title | Status |
|---|---|---|
| 0001 | [Record architecture decisions](0001-record-architecture-decisions.md) | Accepted |
| 0002 | [Target three agent platforms: VS Code, Claude Code, OpenCode](0002-target-three-agent-platforms.md) | Accepted |
| 0003 | [Deterministic core exposed as an MCP server](0003-deterministic-core-as-mcp-server.md) | Accepted |
| 0004 | [Hexagonal architecture with Screaming organization and SOLID](0004-hexagonal-architecture-with-screaming-organization.md) | Accepted |
| 0005 | [TypeScript (strict) and tooling](0005-typescript-strict-and-tooling.md) | Accepted |
| 0006 | [Development workflow: ODD + SDD + Strict TDD](0006-development-workflow-odd-sdd-strict-tdd.md) | Accepted |
| 0007 | [Diagnostic script contract](0007-diagnostic-script-contract.md) | Accepted |
| 0008 | [Sensitive data redaction strategy](0008-sensitive-data-redaction-strategy.md) | Accepted |
| 0009 | [Generator: shared definitions and platform renderers](0009-generator-shared-definitions-and-platform-renderers.md) | Accepted |
| 0010 | [Actor-scoped transitions and allowlisted remediation](0010-actor-scoped-transitions-and-allowlisted-remediation.md) | Accepted |
| 0011 | [Zod in the domain layer](0011-zod-in-the-domain-layer.md) | Accepted |
