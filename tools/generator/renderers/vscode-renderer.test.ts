import { describe, expect, it } from "vitest";
import { assertValidated } from "../validate.js";
import { MODEL } from "../definitions/index.js";
import { vscodeRenderer } from "./vscode-renderer.js";
import { GENERATED_FILE_MARKER, type ValidatedModel } from "./platform-renderer.js";

function validated(): ValidatedModel {
  return assertValidated(MODEL);
}

describe("vscodeRenderer", () => {
  it("declares platform 'vscode'", () => {
    expect(vscodeRenderer.platform).toBe("vscode");
  });

  it("renders exactly one .agent.md per agent, one .prompt.md per prompt, and one mcp.json", () => {
    const files = vscodeRenderer.render(validated());
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(
      [
        ".github/agents/diagnostic.agent.md",
        ".github/agents/escalation.agent.md",
        ".github/agents/triage.agent.md",
        ".github/prompts/diagnose-ticket.prompt.md",
        ".github/prompts/escalate-ticket.prompt.md",
        ".github/prompts/new-ticket.prompt.md",
        ".github/prompts/ticket-status.prompt.md",
        ".vscode/mcp.json",
      ].sort(),
    );
  });

  it("is deterministic: rendering twice produces byte-identical output", () => {
    const first = vscodeRenderer.render(validated());
    const second = vscodeRenderer.render(validated());
    expect(second).toEqual(first);
  });

  it("every rendered file ends with exactly one LF newline and has no CR", () => {
    for (const file of vscodeRenderer.render(validated())) {
      expect(file.contents.endsWith("\n"), file.path).toBe(true);
      expect(file.contents.endsWith("\n\n"), file.path).toBe(false);
      expect(file.contents.includes("\r"), file.path).toBe(false);
    }
  });

  describe("agent files", () => {
    function agentFile(id: string) {
      const file = vscodeRenderer.render(validated()).find((f) => f.path === `.github/agents/${id}.agent.md`);
      if (!file) throw new Error(`no agent file for ${id}`);
      return file.contents;
    }

    it("includes the generated-file marker right after the frontmatter", () => {
      expect(agentFile("triage")).toContain(`---\n${GENERATED_FILE_MARKER}\n`);
    });

    it("triage's frontmatter maps capabilities to helpdesk/<tool> tool names", () => {
      const contents = agentFile("triage");
      expect(contents).toContain("name: triage");
      expect(contents).toContain(
        "tools:\n  - helpdesk/create_ticket\n  - helpdesk/get_ticket\n  - helpdesk/list_tickets\n  - helpdesk/update_ticket\n  - helpdesk/append_audit",
      );
    });

    it("triage's frontmatter declares native handoffs to diagnostic and escalation, each passing no explicit data other than a continuation prompt, and send: false", () => {
      const contents = agentFile("triage");
      expect(contents).toContain("handoffs:\n  - label:");
      expect(contents).toMatch(/- label:.*\n\s+agent: diagnostic\n\s+prompt:.*\n\s+send: false/);
      expect(contents).toMatch(/- label:.*\n\s+agent: escalation\n\s+prompt:.*\n\s+send: false/);
    });

    it("escalation has no handoffs field (it is a dead end)", () => {
      const contents = agentFile("escalation");
      expect(contents).not.toContain("handoffs:");
    });

    it("embeds the agent's instructions verbatim in the body", () => {
      expect(agentFile("diagnostic")).toContain("You diagnose and, when safe, remediate");
    });
  });

  describe("prompt files", () => {
    function promptFile(id: string) {
      const file = vscodeRenderer.render(validated()).find((f) => f.path === `.github/prompts/${id}.prompt.md`);
      if (!file) throw new Error(`no prompt file for ${id}`);
      return file.contents;
    }

    it("new-ticket's frontmatter names the triage agent and rewrites {{description}} to ${input:description}", () => {
      const contents = promptFile("new-ticket");
      expect(contents).toContain("agent: triage");
      expect(contents).toContain("${input:description}");
      expect(contents).not.toContain("{{description}}");
    });

    it("escalate-ticket rewrites both {{ticketId}} and {{reason}}", () => {
      const contents = promptFile("escalate-ticket");
      expect(contents).toContain("${input:ticketId}");
      expect(contents).toContain("${input:reason}");
    });

    it("a prompt's tools frontmatter equals its agent's mapped tools", () => {
      const contents = promptFile("diagnose-ticket");
      expect(contents).toContain(
        "tools:\n  - helpdesk/get_ticket\n  - helpdesk/list_tickets\n  - helpdesk/update_ticket\n  - helpdesk/append_audit\n  - helpdesk/run_diagnostic\n  - helpdesk/apply_remediation",
      );
    });
  });

  describe(".vscode/mcp.json", () => {
    function mcpJson(): unknown {
      const file = vscodeRenderer.render(validated()).find((f) => f.path === ".vscode/mcp.json");
      if (!file) throw new Error("no .vscode/mcp.json rendered");
      return JSON.parse(file.contents);
    }

    it("is valid JSON with no generated-file marker (JSON cannot hold comments)", () => {
      const file = vscodeRenderer.render(validated()).find((f) => f.path === ".vscode/mcp.json")!;
      expect(file.contents).not.toContain("Generated by");
      expect(() => JSON.parse(file.contents)).not.toThrow();
    });

    it("declares the helpdesk server with the exact launch command from the model", () => {
      const json = mcpJson() as { servers: Record<string, unknown> };
      expect(json.servers.helpdesk).toEqual({
        type: "stdio",
        command: "npx",
        args: ["tsx", "src/app/mcp/main.ts"],
        env: { HELPDESK_PSEUDONYM_KEY: "${input:helpdesk-pseudonym-key}" },
      });
    });

    it("declares HELPDESK_PSEUDONYM_KEY as a password input, never a committed value", () => {
      const json = mcpJson() as { inputs: Array<Record<string, unknown>> };
      expect(json.inputs).toEqual([
        {
          type: "promptString",
          id: "helpdesk-pseudonym-key",
          description: "HELPDESK_PSEUDONYM_KEY",
          password: true,
        },
      ]);
    });
  });
});
