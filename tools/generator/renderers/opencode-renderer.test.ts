import { describe, expect, it } from "vitest";
import { assertValidated } from "../validate.js";
import { MODEL } from "../definitions/index.js";
import type { GeneratorModel } from "../definitions/schema.js";
import { opencodeRenderer } from "./opencode-renderer.js";
import { GENERATED_FILE_MARKER, type ValidatedModel } from "./platform-renderer.js";

function validated(): ValidatedModel {
  return assertValidated(MODEL);
}

const MCP_SERVER: GeneratorModel["mcpServer"] = {
  name: "helpdesk",
  command: "npx",
  args: ["tsx", "src/app/mcp/main.ts"],
  env: [],
};

describe("opencodeRenderer", () => {
  it("declares platform 'opencode'", () => {
    expect(opencodeRenderer.platform).toBe("opencode");
  });

  it("renders one subagent per model agent, the derived orchestrator, one command per prompt, and opencode.json", () => {
    const paths = opencodeRenderer.render(validated()).map((f) => f.path).sort();
    expect(paths).toEqual(
      [
        ".opencode/agents/diagnostic.md",
        ".opencode/agents/escalation.md",
        ".opencode/agents/helpdesk-orchestrator.md",
        ".opencode/agents/triage.md",
        ".opencode/commands/diagnose-ticket.md",
        ".opencode/commands/escalate-ticket.md",
        ".opencode/commands/new-ticket.md",
        ".opencode/commands/ticket-status.md",
        "opencode.json",
      ].sort(),
    );
  });

  it("is deterministic across renders", () => {
    expect(opencodeRenderer.render(validated())).toEqual(opencodeRenderer.render(validated()));
  });

  it("every rendered file ends with exactly one LF newline", () => {
    for (const file of opencodeRenderer.render(validated())) {
      expect(file.contents.endsWith("\n"), file.path).toBe(true);
      expect(file.contents.endsWith("\n\n"), file.path).toBe(false);
    }
  });

  describe("subagents", () => {
    function agentFile(id: string) {
      const file = opencodeRenderer.render(validated()).find((f) => f.path === `.opencode/agents/${id}.md`);
      if (!file) throw new Error(`no agent file for ${id}`);
      return file.contents;
    }

    it("declares mode: subagent and permission.task denying every target", () => {
      const contents = agentFile("triage");
      expect(contents).toContain("mode: subagent");
      expect(contents).toContain('permission:\n  task:\n    "*": deny');
    });

    it("enables exactly the tools its capabilities map to and disables every other helpdesk tool by name (no wildcard support)", () => {
      const contents = agentFile("triage");
      expect(contents).toContain("helpdesk_create_ticket: true");
      expect(contents).toContain("helpdesk_get_ticket: true");
      expect(contents).toContain("helpdesk_list_tickets: true");
      expect(contents).toContain("helpdesk_update_ticket: true");
      expect(contents).toContain("helpdesk_append_audit: true");
      expect(contents).toContain("helpdesk_run_diagnostic: false");
      expect(contents).toContain("helpdesk_apply_remediation: false");
    });

    it("escalation has no diagnostic.run or remediation.apply tool enabled", () => {
      const contents = agentFile("escalation");
      expect(contents).toContain("helpdesk_run_diagnostic: false");
      expect(contents).toContain("helpdesk_apply_remediation: false");
    });

    it("embeds the generated-file marker and the agent's instructions", () => {
      const contents = agentFile("diagnostic");
      expect(contents).toContain(GENERATED_FILE_MARKER);
      expect(contents).toContain("You diagnose and, when safe, remediate");
    });
  });

  describe("derived helpdesk-orchestrator", () => {
    function orchestrator() {
      const file = opencodeRenderer.render(validated()).find((f) => f.path === ".opencode/agents/helpdesk-orchestrator.md");
      if (!file) throw new Error("no helpdesk-orchestrator.md rendered");
      return file.contents;
    }

    it("declares mode: primary", () => {
      expect(orchestrator()).toContain("mode: primary");
    });

    it("permission.task denies '*' by default and allows exactly the three subagent ids", () => {
      const contents = orchestrator();
      expect(contents).toContain(
        ['permission:', "  task:", '    "*": deny', "    triage: allow", "    diagnostic: allow", "    escalation: allow"].join(
          "\n",
        ),
      );
    });

    it("holds only the ticket.read tools (get_ticket, list_tickets), no create/update/audit/diagnostic/remediation tool", () => {
      const contents = orchestrator();
      expect(contents).toContain("helpdesk_get_ticket: true");
      expect(contents).toContain("helpdesk_list_tickets: true");
      expect(contents).toContain("helpdesk_create_ticket: false");
      expect(contents).toContain("helpdesk_update_ticket: false");
      expect(contents).toContain("helpdesk_append_audit: false");
      expect(contents).toContain("helpdesk_run_diagnostic: false");
      expect(contents).toContain("helpdesk_apply_remediation: false");
    });

    it("describes starting at triage and re-checking ticket state with get_ticket between steps", () => {
      const contents = orchestrator();
      expect(contents).toMatch(/\btriage\b/);
      expect(contents).toContain("get_ticket");
    });

    it("states the hard-stop bound with the exact phrase, not merely a document that contains '3' somewhere", () => {
      expect(orchestrator()).toContain("Never invoke more than 3 subagents in total for one ticket");
    });

    it("tracks longestHandoffPath + 1 for a different graph (a -> b -> c -> d, longestHandoffPath 3, bound 4)", () => {
      const model: GeneratorModel = {
        agents: [
          { id: "a", role: "triage", description: "d", instructions: "i", capabilities: ["ticket.create"], handoffs: ["b"] },
          { id: "b", role: "diagnostic", description: "d", instructions: "i", capabilities: ["ticket.read"], handoffs: ["c"] },
          { id: "c", role: "diagnostic", description: "d", instructions: "i", capabilities: ["ticket.read"], handoffs: ["d"] },
          { id: "d", role: "escalation", description: "d", instructions: "i", capabilities: ["ticket.read"], handoffs: [] },
        ],
        prompts: [],
        mcpServer: MCP_SERVER,
      };
      const validatedModel = assertValidated(model);
      expect(validatedModel.longestHandoffPath).toBe(3);

      const file = opencodeRenderer
        .render(validatedModel)
        .find((f) => f.path === ".opencode/agents/helpdesk-orchestrator.md");
      if (!file) throw new Error("no helpdesk-orchestrator.md rendered");
      expect(file.contents).toContain("Never invoke more than 4 subagents in total for one ticket");
    });
  });

  describe("commands", () => {
    function commandFile(id: string) {
      const file = opencodeRenderer.render(validated()).find((f) => f.path === `.opencode/commands/${id}.md`);
      if (!file) throw new Error(`no command file for ${id}`);
      return file.contents;
    }

    it("routes each command to its prompt's agent", () => {
      expect(commandFile("diagnose-ticket")).toContain("agent: diagnostic");
      expect(commandFile("escalate-ticket")).toContain("agent: escalation");
    });

    it("new-ticket's free-text param becomes $ARGUMENTS", () => {
      const contents = commandFile("new-ticket");
      expect(contents).toContain("$ARGUMENTS");
      expect(contents).not.toContain("{{description}}");
    });

    it("diagnose-ticket's single-token param becomes the 1-indexed positional $1", () => {
      const contents = commandFile("diagnose-ticket");
      expect(contents).toContain("$1");
      expect(contents).not.toContain("{{ticketId}}");
    });

    it("escalate-ticket's two single-token params become $1 and $2 in declared order", () => {
      const contents = commandFile("escalate-ticket");
      expect(contents).toContain("$1");
      expect(contents).toContain("$2");
    });
  });

  describe("opencode.json", () => {
    it("declares the helpdesk MCP server with {env:VAR} interpolation", () => {
      const file = opencodeRenderer.render(validated()).find((f) => f.path === "opencode.json")!;
      const json = JSON.parse(file.contents);
      expect(json).toEqual({
        $schema: "https://opencode.ai/config.json",
        mcp: {
          helpdesk: {
            type: "local",
            command: ["npx", "tsx", "src/app/mcp/main.ts"],
            environment: { HELPDESK_PSEUDONYM_KEY: "{env:HELPDESK_PSEUDONYM_KEY}" },
            enabled: true,
          },
        },
      });
    });
  });
});
