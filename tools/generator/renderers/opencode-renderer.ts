import { TOOL_NAMES } from "../../../src/app/mcp/tool-names.js";
import { toolsForCapabilities } from "../capabilities.js";
import type { AgentDefinition, Capability, GeneratorModel, PromptDefinition } from "../definitions/schema.js";
import { GENERATED_FILE_MARKER, type PlatformRenderer, type RenderedFile, type ValidatedModel } from "./platform-renderer.js";
import { renderFrontmatterFile } from "./frontmatter.js";
import { substitutePlaceholders } from "./template.js";

/** ADR 0009 / the feature document: OpenCode prefixes bare tool names `helpdesk_<tool>`. */
function opencodeToolName(tool: string): string {
  return `helpdesk_${tool}`;
}

/**
 * OpenCode's `tools` boolean map has no wildcard/glob support (unlike
 * `permission`, which is glob-and-last-match-wins): restricting an agent to
 * a subset of tools means enumerating every tool name explicitly. This
 * builds that explicit map over the full, fixed `TOOL_NAMES` list, so a
 * tool this agent's capabilities do not grant is always spelled out as
 * `false` rather than silently defaulting to enabled.
 */
function toolsMap(granted: readonly Capability[]): Record<string, boolean> {
  const grantedTools = new Set(toolsForCapabilities(granted));
  const map: Record<string, boolean> = {};
  for (const tool of TOOL_NAMES) {
    map[opencodeToolName(tool)] = grantedTools.has(tool);
  }
  return map;
}

function renderSubagentFile(agent: AgentDefinition): RenderedFile {
  const frontmatter = {
    description: agent.description,
    mode: "subagent",
    tools: toolsMap(agent.capabilities),
    permission: { task: { "*": "deny" } },
  };
  const body = [GENERATED_FILE_MARKER, "", agent.instructions].join("\n");
  return { path: `.opencode/agents/${agent.id}.md`, contents: renderFrontmatterFile(frontmatter, body) };
}

/** The agent no other agent hands off to: the only sensible place to start the driven sequence. */
function findEntryAgent(agents: readonly AgentDefinition[]): AgentDefinition {
  const targeted = new Set(agents.flatMap((agent) => agent.handoffs));
  const entries = agents.filter((agent) => !targeted.has(agent.id));
  if (entries.length !== 1) {
    throw new Error(
      `opencodeRenderer: expected exactly one entry agent (no incoming handoffs), found ${entries.length}: ${entries.map((a) => a.id).join(", ") || "none"}`,
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
 * The OpenCode-only derived primary (ADR 0009, schema.ts: "synthesized
 * entirely by the OpenCode renderer from the validated handoff graph" — it
 * is never authored as an `AgentDefinition`). It drives the same bounded
 * sequence Claude Code's `helpdesk-run` command describes, but through
 * `permission.task` rather than a parsed text contract: OpenCode's primary
 * agent invokes a subagent through the Task tool, and `permission.task`
 * (glob, last-match-wins) is the mechanism that actually enforces which
 * subagent ids it may invoke, deny-by-default then allow-listed.
 *
 * The orchestrator's own tools are restricted to `ticket.read`
 * (`get_ticket`, `list_tickets`) and nothing else — no create, update,
 * audit, diagnostic or remediation tool. This is deliberate: it is what
 * lets the orchestrator decide the next hop from the ticket's own
 * server-recorded state after each subagent step, rather than trusting a
 * subagent's own freeform claim about what it did (the same
 * server-is-the-source-of-truth principle ADR 0010 applies to actor-scoped
 * transitions). It never itself creates, updates, diagnoses or remediates a
 * ticket — every state-changing action stays inside the subagent whose role
 * actually owns it.
 */
function renderOrchestratorFile(model: GeneratorModel, longestHandoffPath: number): RenderedFile {
  const entryAgent = findEntryAgent(model.agents);
  const maxInvocations = longestHandoffPath + 1;

  const taskPermission: Record<string, string> = { "*": "deny" };
  for (const agent of model.agents) {
    taskPermission[agent.id] = "allow";
  }

  const frontmatter = {
    description: "Coordinates the help desk agent sequence for one ticket across the helpdesk subagents.",
    mode: "primary",
    tools: toolsMap(["ticket.read"]),
    permission: { task: taskPermission },
  };

  const body = [
    GENERATED_FILE_MARKER,
    "",
    "Run the help desk agent sequence for one ticket, starting from the",
    `\`${entryAgent.id}\` subagent (the only agent in this model that no other agent hands`,
    "off to).",
    "",
    "## Procedure",
    "",
    `1. Invoke the \`${entryAgent.id}\` subagent with the user's request as its input.`,
    "2. After it finishes, call `get_ticket` yourself to read the ticket's current",
    "   state — never rely on the subagent's own claim about what it did.",
    "3. Decide the next subagent, if any, from that server-recorded state and the",
    "   handoff graph below. If no further handoff applies, stop: the sequence is",
    "   complete.",
    "4. Invoke the next subagent with only the ticket id; it re-reads everything",
    "   else itself with `get_ticket`. Go back to step 2.",
    "",
    "## Handoff graph",
    "",
    renderGraphSummary(model.agents),
    "",
    "## Hard stop",
    "",
    `Never invoke more than ${maxInvocations} subagents in total for one ticket (this`,
    `model's longest handoff path is ${longestHandoffPath} edge${longestHandoffPath === 1 ? "" : "s"}, plus`,
    "one for the starting agent). If that bound is reached, stop and tell the user a",
    "person will follow up; do not keep invoking subagents.",
  ].join("\n");

  return { path: ".opencode/agents/helpdesk-orchestrator.md", contents: renderFrontmatterFile(frontmatter, body) };
}

/** OpenCode command positional arguments are 1-indexed (`$1` is the first argument). */
function rewriteTemplateForOpenCode(prompt: PromptDefinition): string {
  if (prompt.params.length === 1 && prompt.params[0]?.kind === "free-text") {
    return substitutePlaceholders(prompt.template, () => "$ARGUMENTS");
  }
  const positionByName = new Map(prompt.params.map((param, index) => [param.name, index + 1]));
  return substitutePlaceholders(prompt.template, (name) => {
    const position = positionByName.get(name);
    return position === undefined ? `{{${name}}}` : `$${position}`;
  });
}

function renderCommandFile(prompt: PromptDefinition): RenderedFile {
  const frontmatter = { description: prompt.description, agent: prompt.agent };
  const body = [GENERATED_FILE_MARKER, "", rewriteTemplateForOpenCode(prompt)].join("\n");
  return { path: `.opencode/commands/${prompt.id}.md`, contents: renderFrontmatterFile(frontmatter, body) };
}

function renderOpencodeConfig(model: GeneratorModel): RenderedFile {
  const { mcpServer } = model;
  const environment: Record<string, string> = {};
  for (const envVarName of mcpServer.env) {
    environment[envVarName] = `{env:${envVarName}}`;
  }
  const config = {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      [mcpServer.name]: {
        type: "local",
        command: [mcpServer.command, ...mcpServer.args],
        environment,
        enabled: true,
      },
    },
  };
  return { path: "opencode.json", contents: `${JSON.stringify(config, null, 2)}\n` };
}

export const opencodeRenderer: PlatformRenderer = {
  platform: "opencode",
  render(model: ValidatedModel): readonly RenderedFile[] {
    return [
      ...model.model.agents.map(renderSubagentFile),
      renderOrchestratorFile(model.model, model.longestHandoffPath),
      ...model.model.prompts.map(renderCommandFile),
      renderOpencodeConfig(model.model),
    ];
  },
};
