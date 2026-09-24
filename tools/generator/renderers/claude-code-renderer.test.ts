import { describe, expect, it } from "vitest";
import { validateModel } from "../validate.js";
import { MODEL } from "../definitions/index.js";
import { claudeCodeRenderer } from "./claude-code-renderer.js";
import { GENERATED_FILE_MARKER, type ValidatedModel } from "./platform-renderer.js";

function validated(): ValidatedModel {
  const result = validateModel(MODEL);
  if (!result.ok) throw new Error(`fixture model is invalid: ${result.errors.join("; ")}`);
  return { model: MODEL, longestHandoffPath: result.longestHandoffPath };
}

describe("claudeCodeRenderer", () => {
  it("declares platform 'claude-code'", () => {
    expect(claudeCodeRenderer.platform).toBe("claude-code");
  });

  it("renders one agent per agent, one command per prompt, the helpdesk-run driver, and .mcp.json", () => {
    const paths = claudeCodeRenderer.render(validated()).map((f) => f.path).sort();
    expect(paths).toEqual(
      [
        ".claude/agents/diagnostic.md",
        ".claude/agents/escalation.md",
        ".claude/agents/triage.md",
        ".claude/commands/diagnose-ticket.md",
        ".claude/commands/escalate-ticket.md",
        ".claude/commands/helpdesk-run.md",
        ".claude/commands/new-ticket.md",
        ".claude/commands/ticket-status.md",
        ".mcp.json",
      ].sort(),
    );
  });

  it("is deterministic across renders", () => {
    expect(claudeCodeRenderer.render(validated())).toEqual(claudeCodeRenderer.render(validated()));
  });

  it("every rendered file ends with exactly one LF newline", () => {
    for (const file of claudeCodeRenderer.render(validated())) {
      expect(file.contents.endsWith("\n"), file.path).toBe(true);
      expect(file.contents.endsWith("\n\n"), file.path).toBe(false);
    }
  });

  describe("agent files", () => {
    function agentFile(id: string) {
      const file = claudeCodeRenderer.render(validated()).find((f) => f.path === `.claude/agents/${id}.md`);
      if (!file) throw new Error(`no agent file for ${id}`);
      return file.contents;
    }

    it("maps tools to a comma-separated mcp__helpdesk__<tool> list", () => {
      const contents = agentFile("triage");
      expect(contents).toContain(
        "tools: mcp__helpdesk__create_ticket, mcp__helpdesk__get_ticket, mcp__helpdesk__list_tickets, mcp__helpdesk__update_ticket, mcp__helpdesk__append_audit",
      );
    });

    it("has no declarative handoffs frontmatter field (Claude subagents have none)", () => {
      expect(agentFile("triage")).not.toMatch(/^handoffs:/m);
    });

    it("embeds the agent's instructions and the generated-file marker", () => {
      const contents = agentFile("diagnostic");
      expect(contents).toContain(GENERATED_FILE_MARKER);
      expect(contents).toContain("You diagnose and, when safe, remediate");
    });

    it("triage's body ends with a HANDOFF contract listing diagnostic, escalation and none as allowed targets", () => {
      const contents = agentFile("triage");
      expect(contents).toContain("HANDOFF: <target> ticket=<ticketId>");
      expect(contents).toMatch(/diagnostic.*escalation.*none|escalation.*diagnostic.*none/s);
    });

    it("escalation's HANDOFF contract allows only none (it is a dead end)", () => {
      const contents = agentFile("escalation");
      const contractSection = contents.slice(contents.indexOf("## Handoff contract"));
      expect(contractSection).not.toContain("diagnostic");
      expect(contractSection).not.toContain("escalation,");
      expect(contractSection).toContain("none");
    });
  });

  describe("command files", () => {
    function commandFile(id: string) {
      const file = claudeCodeRenderer.render(validated()).find((f) => f.path === `.claude/commands/${id}.md`);
      if (!file) throw new Error(`no command file for ${id}`);
      return file.contents;
    }

    it("new-ticket's single free-text param becomes $ARGUMENTS", () => {
      const contents = commandFile("new-ticket");
      expect(contents).toContain("$ARGUMENTS");
      expect(contents).not.toContain("{{description}}");
    });

    it("diagnose-ticket's single single-token param becomes the 0-indexed positional $0", () => {
      const contents = commandFile("diagnose-ticket");
      expect(contents).toContain("$0");
      expect(contents).not.toContain("{{ticketId}}");
    });

    it("escalate-ticket's two single-token params become $0 and $1 in declared order", () => {
      const contents = commandFile("escalate-ticket");
      expect(contents).toContain("$0");
      expect(contents).toContain("$1");
      expect(contents).not.toContain("{{ticketId}}");
      expect(contents).not.toContain("{{reason}}");
    });
  });

  describe(".claude/commands/helpdesk-run.md", () => {
    function driver() {
      const file = claudeCodeRenderer.render(validated()).find((f) => f.path === ".claude/commands/helpdesk-run.md");
      if (!file) throw new Error("no helpdesk-run.md rendered");
      return file.contents;
    }

    it("names triage as the starting agent (the only agent no other agent hands off to)", () => {
      expect(driver()).toMatch(/start(s|ing)?[\s\S]{0,60}\btriage\b/i);
    });

    it("states the hard-stop bound numerically as longestHandoffPath + 1 = 3", () => {
      expect(driver()).toContain("3");
    });

    it("instructs reading the HANDOFF line and stopping on none", () => {
      const contents = driver();
      expect(contents).toContain("HANDOFF:");
      expect(contents.toLowerCase()).toContain("none");
    });
  });

  describe(".mcp.json", () => {
    it("launches the server exactly per the model, with env interpolated as ${VAR}", () => {
      const file = claudeCodeRenderer.render(validated()).find((f) => f.path === ".mcp.json")!;
      const json = JSON.parse(file.contents);
      expect(json).toEqual({
        mcpServers: {
          helpdesk: {
            command: "npx",
            args: ["tsx", "src/app/mcp/main.ts"],
            env: { HELPDESK_PSEUDONYM_KEY: "${HELPDESK_PSEUDONYM_KEY}" },
          },
        },
      });
    });
  });
});
