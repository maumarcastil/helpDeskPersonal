# 0002. Target three agent platforms: VS Code, Claude Code, OpenCode

- Status: Accepted
- Date: 2026-09-23

## Context

The technical test asks for a help desk agent ecosystem built on editor agent customization — custom instructions, agent skills with an auxiliary script, custom agents with handoffs, and prompt files — implemented in Node.js. The ecosystem must work across three editor agent platforms: VS Code (GitHub Copilot), Claude Code, and OpenCode. Each platform reads a different, only partially overlapping set of customization files, verified against official documentation (September 2026):

| Concern | VS Code (Copilot) | Claude Code | OpenCode |
|---|---|---|---|
| Agent Skills | `.claude/skills/<name>/SKILL.md` (open Agent Skills standard) | same path | same path |
| Custom instructions | Reads `AGENTS.md` and `CLAUDE.md` | Reads `CLAUDE.md` | Reads `AGENTS.md` (falls back to `CLAUDE.md` only if no `AGENTS.md`) |
| Custom agents | `.github/agents/*.agent.md` with native `handoffs`; also reads `.claude/agents` | `.claude/agents/*.md` (subagents, no declarative handoffs) | `.opencode/agents/*.md` (`mode`, `permission`; delegation via Task tool and `permission.task`) |
| Commands / prompts | `.github/prompts/*.prompt.md` (`${input:var}`) | `.claude/commands/` | `.opencode/commands/` (`$ARGUMENTS`, `$1`) |
| MCP config | `.vscode/mcp.json` | `.mcp.json` | `opencode.json` |

Because Agent Skills already follow one open standard, a single `.claude/skills/` tree is read identically by all three platforms. Instructions, agents, commands, and MCP config are not portable as-is.

## Decision

Target all three platforms from one source of truth, splitting customization assets into what is naturally portable and what must be generated per platform (mechanism defined in ADR 0004):

- **Skills** (`.claude/skills/<name>/SKILL.md`): a single shared copy, since all three platforms read this same path under the open Agent Skills standard.
- **Instructions**: `AGENTS.md` is the source of truth (read natively by VS Code and OpenCode); `CLAUDE.md` is kept only as a one-line pointer (`@AGENTS.md`) so Claude Code picks up the same content without duplicating it.
- **Agents, commands/prompts, MCP config**: platform-specific formats and locations, produced from a shared definition by a build-time generator (see ADR 0004) rather than shared as files.

## Alternatives considered

- **Support a single platform only** — rejected: the test explicitly requires portability across VS Code, Claude Code, and OpenCode.
- **Hand-maintained duplicates per platform** — rejected: every agent, command, and instruction file would need three manually synchronized copies, which drifts silently as soon as one copy is edited and not the others.

## Consequences

**Positive**

- Skills need to be written once and work unmodified on all three platforms.
- Instructions have one authored source (`AGENTS.md`), eliminating drift between "what Copilot sees" and "what Claude Code sees."
- Platform differences (handoffs syntax, prompt variable syntax, MCP config shape) are handled in one place (the generator) instead of three.

**Negative**

- Agents and commands are not directly hand-editable per platform; changes must go through the shared definition and generator, adding one indirection step.
- The generator itself becomes a piece of infrastructure that needs its own correctness guarantees (see ADR 0004).

## Sources

- https://code.visualstudio.com/docs/copilot/customization/overview
- https://code.visualstudio.com/docs/copilot/customization/agent-skills
- https://code.visualstudio.com/docs/copilot/customization/custom-agents
- https://opencode.ai/docs/skills/
- https://opencode.ai/docs/agents/
- https://opencode.ai/docs/rules/
- https://opencode.ai/docs/commands/
- https://opencode.ai/docs/mcp-servers/
