import { describe, expect, it } from "vitest";
import { validateModel } from "../validate.js";
import { AGENTS } from "./agents.js";
import { MCP_SERVER } from "./mcp-server.js";
import { PROMPTS } from "./prompts.js";
import { MODEL } from "./index.js";

describe("real generator definitions", () => {
  it("MODEL is the exact aggregate of AGENTS, PROMPTS and MCP_SERVER", () => {
    expect(MODEL).toEqual({ agents: AGENTS, prompts: PROMPTS, mcpServer: MCP_SERVER });
  });

  it("passes validateModel with no errors", () => {
    const result = validateModel(MODEL);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("has a longest handoff path of 2 (triage -> diagnostic -> escalation)", () => {
    expect(validateModel(MODEL).longestHandoffPath).toBe(2);
  });

  it("declares exactly triage, diagnostic and escalation, each once", () => {
    expect(AGENTS.map((a) => a.id).sort()).toEqual(["diagnostic", "escalation", "triage"]);
  });

  it("triage hands off to diagnostic and escalation, escalation hands off to nothing", () => {
    const byId = new Map(AGENTS.map((a) => [a.id, a]));
    expect([...byId.get("triage")!.handoffs].sort()).toEqual(["diagnostic", "escalation"]);
    expect(byId.get("diagnostic")!.handoffs).toEqual(["escalation"]);
    expect(byId.get("escalation")!.handoffs).toEqual([]);
  });

  it("triage holds exactly the create/read/update/audit capabilities", () => {
    const triage = AGENTS.find((a) => a.id === "triage")!;
    expect([...triage.capabilities].sort()).toEqual(
      ["audit.append", "ticket.create", "ticket.read", "ticket.update"].sort(),
    );
  });

  it("diagnostic holds read/update/audit plus diagnostic.run and remediation.apply", () => {
    const diagnostic = AGENTS.find((a) => a.id === "diagnostic")!;
    expect([...diagnostic.capabilities].sort()).toEqual(
      ["audit.append", "diagnostic.run", "remediation.apply", "ticket.read", "ticket.update"].sort(),
    );
  });

  it("escalation holds exactly read/update/audit, no diagnostic or remediation capability", () => {
    const escalation = AGENTS.find((a) => a.id === "escalation")!;
    expect([...escalation.capabilities].sort()).toEqual(
      ["audit.append", "ticket.read", "ticket.update"].sort(),
    );
  });

  it("the diagnostic agent's instructions point to the connectivity-diagnostic skill", () => {
    const diagnostic = AGENTS.find((a) => a.id === "diagnostic")!;
    expect(diagnostic.instructions).toContain("connectivity-diagnostic");
  });

  it("every handoff target from triage moves a Triaged ticket into InProgress itself", () => {
    // triage may not perform Triaged -> InProgress (only diagnostic and
    // escalation may), so each agent triage hands off to must do it before
    // any step that requires an InProgress ticket.
    const triage = AGENTS.find((a) => a.id === "triage")!;
    for (const targetId of triage.handoffs) {
      const target = AGENTS.find((a) => a.id === targetId)!;
      expect(target.instructions).toContain(
        `update_ticket({ ticketId, actor: "${target.id}", transition: { to: "InProgress" } })`,
      );
    }
  });

  it("every agent's instructions declare its actor value and forbid echoing credentials/PII", () => {
    for (const a of AGENTS) {
      expect(a.instructions).toContain(`actor "${a.id}"`);
      expect(a.instructions.toLowerCase()).toMatch(/credential|password|token/);
    }
  });

  it("declares exactly the four prompts from the feature document", () => {
    expect(PROMPTS.map((p) => p.id).sort()).toEqual([
      "diagnose-ticket",
      "escalate-ticket",
      "new-ticket",
      "ticket-status",
    ]);
  });

  it("new-ticket has one free-text {{description}} param routed to triage", () => {
    const p = PROMPTS.find((p) => p.id === "new-ticket")!;
    expect(p.agent).toBe("triage");
    expect(p.params).toEqual([{ name: "description", kind: "free-text" }]);
  });

  it("diagnose-ticket has one single-token {{ticketId}} param routed to diagnostic", () => {
    const p = PROMPTS.find((p) => p.id === "diagnose-ticket")!;
    expect(p.agent).toBe("diagnostic");
    expect(p.params).toEqual([{ name: "ticketId", kind: "single-token" }]);
  });

  it("escalate-ticket has single-token {{ticketId}} and {{reason}} params routed to escalation", () => {
    const p = PROMPTS.find((p) => p.id === "escalate-ticket")!;
    expect(p.agent).toBe("escalation");
    expect(p.params).toEqual([
      { name: "ticketId", kind: "single-token" },
      { name: "reason", kind: "single-token" },
    ]);
  });

  it("ticket-status has one single-token {{ticketId}} param routed to triage, read-only", () => {
    const p = PROMPTS.find((p) => p.id === "ticket-status")!;
    expect(p.agent).toBe("triage");
    expect(p.params).toEqual([{ name: "ticketId", kind: "single-token" }]);
    expect(p.template.toLowerCase()).toContain("read");
  });

  it("MCP_SERVER launches the server exactly per the feature document's approved decision", () => {
    expect(MCP_SERVER).toEqual({
      name: "helpdesk",
      command: "npx",
      args: ["tsx", "src/app/mcp/main.ts"],
      env: ["HELPDESK_PSEUDONYM_KEY"],
    });
  });
});
