import { toolsForCapabilities } from "../capabilities.js";
import type { AgentDefinition, PromptDefinition } from "../definitions/schema.js";
import {
  assertNoDuplicatePaths,
  GENERATED_FILE_MARKER,
  type PlatformRenderer,
  type RenderedFile,
  type ValidatedModel,
} from "./platform-renderer.js";
import { renderFrontmatterFile } from "./frontmatter.js";
import { substitutePlaceholders } from "./template.js";

/** ADR 0009 / the feature document: VS Code prefixes bare tool names `helpdesk/<tool>`. */
function vscodeTools(agent: AgentDefinition): readonly string[] {
  return toolsForCapabilities(agent.capabilities).map((tool) => `helpdesk/${tool}`);
}

/**
 * VS Code is the only platform with native `handoffs`: a button in the chat
 * UI that hands the conversation to another agent with a pre-filled
 * (`send: false`, so the user can review before sending) prompt. Per ADR
 * 0009 the handoff itself carries only `ticketId` — in VS Code's
 * single-thread chat UI that already means "nothing beyond the
 * conversation's own context", so the generated prompt text tells the next
 * agent to re-read the ticket rather than repeating any of its data.
 */
function renderHandoffs(agent: AgentDefinition): ReadonlyArray<Record<string, string | boolean>> | undefined {
  if (agent.handoffs.length === 0) return undefined;
  return agent.handoffs.map((target) => ({
    label: `Hand off to ${target}`,
    agent: target,
    prompt: `Continue handling this ticket as the ${target} agent. Read its current state with get_ticket first; do not repeat information already on the ticket.`,
    send: false,
  }));
}

function renderAgentFile(agent: AgentDefinition): RenderedFile {
  const frontmatter = {
    name: agent.id,
    description: agent.description,
    tools: vscodeTools(agent),
    handoffs: renderHandoffs(agent),
  };
  const body = `${GENERATED_FILE_MARKER}\n\n${agent.instructions}`;
  return {
    path: `.github/agents/${agent.id}.agent.md`,
    contents: renderFrontmatterFile(frontmatter, body),
  };
}

function renderPromptFile(prompt: PromptDefinition, agentsById: ReadonlyMap<string, AgentDefinition>): RenderedFile {
  const agent = agentsById.get(prompt.agent);
  if (!agent) throw new Error(`vscodeRenderer: prompt "${prompt.id}" refers to unknown agent "${prompt.agent}"`);

  const frontmatter = {
    description: prompt.description,
    agent: agent.id,
    tools: vscodeTools(agent),
  };
  const rewritten = substitutePlaceholders(prompt.template, (name) => `\${input:${name}}`);
  const body = `${GENERATED_FILE_MARKER}\n\n${rewritten}`;
  return {
    path: `.github/prompts/${prompt.id}.prompt.md`,
    contents: renderFrontmatterFile(frontmatter, body),
  };
}

/** `HELPDESK_PSEUDONYM_KEY` -> `helpdesk-pseudonym-key` (a valid `inputs[].id`). */
function envVarToInputId(envVarName: string): string {
  return envVarName.toLowerCase().replace(/_/g, "-");
}

/**
 * `.vscode/mcp.json`. Neither `${env:VAR}` inside `env` nor
 * `.vscode/mcp.json` reading `.claude/agents` were resolvable from the
 * documented, versioned MCP configuration reference at the time this was
 * written (task 6.1/6.7 prerequisite): the reference documents only the
 * `inputs` + `${input:id}` mechanism for a server's `env` values (example:
 * `{"API_KEY": "${input:api-key}"}`), so that is what this renderer uses —
 * a `promptString` input with `password: true` for `HELPDESK_PSEUDONYM_KEY`,
 * never a raw `${env:...}` reference.
 */
function renderMcpConfig(model: ValidatedModel): RenderedFile {
  const { mcpServer } = model.model;
  const inputs = mcpServer.env.map((envVarName) => ({
    type: "promptString",
    id: envVarToInputId(envVarName),
    description: envVarName,
    password: true,
  }));
  const env: Record<string, string> = {};
  for (const envVarName of mcpServer.env) {
    env[envVarName] = `\${input:${envVarToInputId(envVarName)}}`;
  }
  const config = {
    inputs,
    servers: {
      [mcpServer.name]: {
        type: "stdio",
        command: mcpServer.command,
        args: [...mcpServer.args],
        env,
      },
    },
  };
  return { path: ".vscode/mcp.json", contents: `${JSON.stringify(config, null, 2)}\n` };
}

export const vscodeRenderer: PlatformRenderer = {
  platform: "vscode",
  render(model: ValidatedModel): readonly RenderedFile[] {
    const agentsById = new Map(model.model.agents.map((agent) => [agent.id, agent]));
    const files = [
      ...model.model.agents.map(renderAgentFile),
      ...model.model.prompts.map((prompt) => renderPromptFile(prompt, agentsById)),
      renderMcpConfig(model),
    ];
    assertNoDuplicatePaths(files, "vscodeRenderer");
    return files;
  },
};
