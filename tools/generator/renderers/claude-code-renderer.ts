import { toolsForCapabilities } from "../capabilities.js";
import type { AgentDefinition, GeneratorModel, PromptDefinition } from "../definitions/schema.js";
import { GENERATED_FILE_MARKER, type PlatformRenderer, type RenderedFile, type ValidatedModel } from "./platform-renderer.js";
import { renderFrontmatterFile } from "./frontmatter.js";
import { substitutePlaceholders } from "./template.js";

/** ADR 0009 / the feature document: Claude Code prefixes bare tool names `mcp__helpdesk__<tool>`. */
function claudeTools(agent: AgentDefinition): readonly string[] {
  return toolsForCapabilities(agent.capabilities).map((tool) => `mcp__helpdesk__${tool}`);
}

/**
 * Claude Code subagents have no declarative `handoffs` field (ADR 0002), so
 * the handoff itself has to be carried in the subagent's own text output.
 * Every agent's body ends with this exact contract: a final line the
 * driver command (`renderDriverCommand` below) parses to decide the next
 * hop, naming only the targets that agent's own `handoffs` allow (plus
 * `none`, always allowed, meaning "stop here").
 */
function renderHandoffContract(agent: AgentDefinition): string {
  const allowed = [...agent.handoffs, "none"].join(", ");
  return [
    "## Handoff contract",
    "",
    "End your final message with exactly one line, in exactly this form:",
    "",
    "HANDOFF: <target> ticket=<ticketId>",
    "",
    `Allowed values for \`<target>\` from this agent: ${allowed}. Use \`none\` when you` +
      " are not handing this ticket to another agent (for example, after resolving it" +
      " or after an escalation you have already recorded yourself). Always fill in the" +
      " real ticket id, never a placeholder.",
  ].join("\n");
}

function renderAgentFile(agent: AgentDefinition): RenderedFile {
  const frontmatter = {
    name: agent.id,
    description: agent.description,
    tools: claudeTools(agent).join(", "),
  };
  const body = [GENERATED_FILE_MARKER, "", agent.instructions, "", renderHandoffContract(agent)].join("\n");
  return { path: `.claude/agents/${agent.id}.md`, contents: renderFrontmatterFile(frontmatter, body) };
}

/** Positional args are 0-indexed (`$0` is the first argument); `$ARGUMENTS` is the whole free-text string. */
function rewriteTemplateForClaudeCode(prompt: PromptDefinition): string {
  if (prompt.params.length === 1 && prompt.params[0]?.kind === "free-text") {
    return substitutePlaceholders(prompt.template, () => "$ARGUMENTS");
  }
  const indexByName = new Map(prompt.params.map((param, index) => [param.name, index]));
  return substitutePlaceholders(prompt.template, (name) => {
    const index = indexByName.get(name);
    return index === undefined ? `{{${name}}}` : `$${index}`;
  });
}

function argumentHint(prompt: PromptDefinition): string {
  if (prompt.params.length === 1 && prompt.params[0]?.kind === "free-text") {
    return `<${prompt.params[0].name}>`;
  }
  return prompt.params.map((param) => `<${param.name}>`).join(" ");
}

function renderCommandFile(prompt: PromptDefinition): RenderedFile {
  const frontmatter = {
    description: prompt.description,
    "argument-hint": argumentHint(prompt),
  };
  const body = [GENERATED_FILE_MARKER, "", rewriteTemplateForClaudeCode(prompt)].join("\n");
  return { path: `.claude/commands/${prompt.id}.md`, contents: renderFrontmatterFile(frontmatter, body) };
}

/** The agent no other agent hands off to: the only sensible place to start the driven sequence. */
function findEntryAgent(agents: readonly AgentDefinition[]): AgentDefinition {
  const targeted = new Set(agents.flatMap((agent) => agent.handoffs));
  const entries = agents.filter((agent) => !targeted.has(agent.id));
  if (entries.length !== 1) {
    throw new Error(
      `claudeCodeRenderer: expected exactly one entry agent (no incoming handoffs), found ${entries.length}: ${entries.map((a) => a.id).join(", ") || "none"}`,
    );
  }
  return entries[0] as AgentDefinition;
}

function renderGraphSummary(agents: readonly AgentDefinition[]): string {
  return agents
    .map((agent) => {
      const targets = agent.handoffs.length > 0 ? agent.handoffs.join(", ") : "none (dead end)";
      return `- \`${agent.id}\` may hand off to: ${targets}`;
    })
    .join("\n");
}

/**
 * The driver command (task 6.8): runs the whole triage -> diagnostic ->
 * escalation sequence from the main session, since Claude Code subagents
 * cannot invoke each other directly. It is a Markdown prompt, not
 * executable code, so the bound it states is enforced by the operator
 * reading and following it — the same trust boundary ADR 0009 already
 * accepts for Claude Code and OpenCode handoffs ("determinism there relies
 * on server-side enforcement" for the MCP calls themselves; this command
 * only bounds how many *agent invocations* happen, which the server cannot
 * see).
 */
function renderDriverCommand(model: GeneratorModel, longestHandoffPath: number): RenderedFile {
  const entryAgent = findEntryAgent(model.agents);
  const maxInvocations = longestHandoffPath + 1;
  const body = [
    GENERATED_FILE_MARKER,
    "",
    "Run the help desk agent sequence for one ticket, starting from the",
    `\`${entryAgent.id}\` agent (the only agent in this model that no other agent hands`,
    "off to).",
    "",
    "## Procedure",
    "",
    `1. Invoke the \`${entryAgent.id}\` subagent (e.g. via the Task tool) with the user's`,
    "   request as its input.",
    "2. Read that subagent's final `HANDOFF: <target> ticket=<ticketId>` line.",
    "3. If `<target>` is `none`, stop: the sequence is complete.",
    "4. Otherwise, `<target>` must be one of the targets listed below for the agent",
    "   that just ran. Invoke the `<target>` subagent next, passing only the",
    "   `ticketId` from the HANDOFF line — it re-reads everything else itself with",
    "   `get_ticket`. Go back to step 2.",
    "",
    "## Handoff graph",
    "",
    renderGraphSummary(model.agents),
    "",
    "## Hard stop",
    "",
    `Never invoke more than ${maxInvocations} agents in total for one ticket (this`,
    `model's longest handoff path is ${longestHandoffPath} edge${longestHandoffPath === 1 ? "" : "s"}, plus`,
    "one for the starting agent). If that bound is reached without a `HANDOFF: none`",
    "line, stop and tell the user a person will follow up; do not keep invoking",
    "agents.",
  ].join("\n");
  return {
    path: ".claude/commands/helpdesk-run.md",
    contents: renderFrontmatterFile(
      { description: "Run the triage -> diagnostic -> escalation help desk sequence for one ticket." },
      body,
    ),
  };
}

function renderMcpConfig(model: GeneratorModel): RenderedFile {
  const { mcpServer } = model;
  const env: Record<string, string> = {};
  for (const envVarName of mcpServer.env) {
    env[envVarName] = `\${${envVarName}}`;
  }
  const config = {
    mcpServers: {
      [mcpServer.name]: { command: mcpServer.command, args: [...mcpServer.args], env },
    },
  };
  return { path: ".mcp.json", contents: `${JSON.stringify(config, null, 2)}\n` };
}

export const claudeCodeRenderer: PlatformRenderer = {
  platform: "claude-code",
  render(model: ValidatedModel): readonly RenderedFile[] {
    return [
      ...model.model.agents.map(renderAgentFile),
      ...model.model.prompts.map(renderCommandFile),
      renderDriverCommand(model.model, model.longestHandoffPath),
      renderMcpConfig(model.model),
    ];
  },
};
