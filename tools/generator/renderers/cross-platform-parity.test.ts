import { describe, expect, it } from "vitest";
import { validateModel } from "../validate.js";
import { toolsForCapabilities } from "../capabilities.js";
import { MODEL } from "../definitions/index.js";
import { claudeCodeRenderer } from "./claude-code-renderer.js";
import { opencodeRenderer } from "./opencode-renderer.js";
import { vscodeRenderer } from "./vscode-renderer.js";
import type { RenderedFile, ValidatedModel } from "./platform-renderer.js";

/**
 * Cross-platform parity (task 6.10): all three renderers are independent
 * implementations of the same shared model, so nothing but a test actually
 * proves they agree. This file parses each renderer's own deterministic
 * frontmatter format back out (tailored to the exact shape each renderer's
 * emitter produces, not a general YAML parser — see `frontmatter.test.ts`
 * for the emitter's own contract) and checks the three things the feature
 * document requires: identical resolved tool sets after stripping the
 * platform prefix, no agent holding a tool its role forbids, and every
 * handoff target existing as a real agent file on that same platform.
 */

function validated(): ValidatedModel {
  const result = validateModel(MODEL);
  if (!result.ok) throw new Error(`fixture model is invalid: ${result.errors.join("; ")}`);
  return { model: MODEL, longestHandoffPath: result.longestHandoffPath };
}

function fileFor(files: readonly RenderedFile[], path: string): RenderedFile {
  const file = files.find((f) => f.path === path);
  if (!file) throw new Error(`no rendered file at "${path}"`);
  return file;
}

/** VS Code's block-sequence `tools:\n  - helpdesk/<tool>\n  - ...` (see vscode-renderer.ts). */
function vscodeAgentTools(contents: string): readonly string[] {
  const match = contents.match(/\ntools:\n((?:  - helpdesk\/\S+\n)+)/);
  if (!match) return [];
  return [...(match[1] as string).matchAll(/ {2}- helpdesk\/(\S+)\n/g)].map((m) => m[1] as string);
}

/** Claude Code's single-line `tools: mcp__helpdesk__a, mcp__helpdesk__b` (see claude-code-renderer.ts). */
function claudeCodeAgentTools(contents: string): readonly string[] {
  const match = contents.match(/\ntools: (.+)\n/);
  if (!match) return [];
  return (match[1] as string)
    .split(", ")
    .map((entry) => entry.replace(/^mcp__helpdesk__/, ""));
}

/** OpenCode's boolean map `tools:\n  helpdesk_a: true\n  helpdesk_b: false\n...` (see opencode-renderer.ts). */
function opencodeAgentTools(contents: string): readonly string[] {
  const match = contents.match(/\ntools:\n((?:  helpdesk_\S+: (?:true|false)\n)+)/);
  if (!match) return [];
  return [...(match[1] as string).matchAll(/ {2}helpdesk_(\S+): true\n/g)].map((m) => m[1] as string);
}

describe("cross-platform tool parity", () => {
  const vscodeFiles = vscodeRenderer.render(validated());
  const claudeFiles = claudeCodeRenderer.render(validated());
  const opencodeFiles = opencodeRenderer.render(validated());

  it.each(MODEL.agents.map((agent) => agent.id))(
    "agent '%s': the resolved tool set is identical on all three platforms and equals capabilities -> tools",
    (agentId) => {
      const agent = MODEL.agents.find((a) => a.id === agentId)!;
      const expected = [...toolsForCapabilities(agent.capabilities)].sort();

      const vscodeTools = [...vscodeAgentTools(fileFor(vscodeFiles, `.github/agents/${agentId}.agent.md`).contents)].sort();
      const claudeTools = [...claudeCodeAgentTools(fileFor(claudeFiles, `.claude/agents/${agentId}.md`).contents)].sort();
      const opencodeTools = [...opencodeAgentTools(fileFor(opencodeFiles, `.opencode/agents/${agentId}.md`).contents)].sort();

      expect(vscodeTools, "vscode").toEqual(expected);
      expect(claudeTools, "claude-code").toEqual(expected);
      expect(opencodeTools, "opencode").toEqual(expected);
    },
  );

  it("no agent's resolved tools include run_diagnostic or apply_remediation unless its capabilities grant diagnostic.run / remediation.apply", () => {
    for (const agent of MODEL.agents) {
      const grantsDiagnostic = agent.capabilities.includes("diagnostic.run");
      const grantsRemediation = agent.capabilities.includes("remediation.apply");

      const vscodeTools = vscodeAgentTools(fileFor(vscodeFiles, `.github/agents/${agent.id}.agent.md`).contents);
      const claudeTools = claudeCodeAgentTools(fileFor(claudeFiles, `.claude/agents/${agent.id}.md`).contents);
      const opencodeTools = opencodeAgentTools(fileFor(opencodeFiles, `.opencode/agents/${agent.id}.md`).contents);

      for (const [platform, tools] of [
        ["vscode", vscodeTools],
        ["claude-code", claudeTools],
        ["opencode", opencodeTools],
      ] as const) {
        expect(tools.includes("run_diagnostic"), `${agent.id} on ${platform}`).toBe(grantsDiagnostic);
        expect(tools.includes("apply_remediation"), `${agent.id} on ${platform}`).toBe(grantsRemediation);
      }
    }
  });
});

describe("cross-platform handoff target existence", () => {
  const vscodeFiles = vscodeRenderer.render(validated());
  const claudeFiles = claudeCodeRenderer.render(validated());
  const opencodeFiles = opencodeRenderer.render(validated());

  it("every handoff target in the model has an agent file on every platform", () => {
    const vscodePaths = new Set(vscodeFiles.map((f) => f.path));
    const claudePaths = new Set(claudeFiles.map((f) => f.path));
    const opencodePaths = new Set(opencodeFiles.map((f) => f.path));

    for (const agent of MODEL.agents) {
      for (const target of agent.handoffs) {
        expect(vscodePaths.has(`.github/agents/${target}.agent.md`), `vscode: ${agent.id} -> ${target}`).toBe(true);
        expect(claudePaths.has(`.claude/agents/${target}.md`), `claude-code: ${agent.id} -> ${target}`).toBe(true);
        expect(opencodePaths.has(`.opencode/agents/${target}.md`), `opencode: ${agent.id} -> ${target}`).toBe(true);
      }
    }
  });
});
