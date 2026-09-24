import { describe, expect, it } from "vitest";
import {
  AgentDefinitionSchema,
  checkPromptTemplate,
  extractPlaceholders,
  GeneratorModelSchema,
  McpServerDefinitionSchema,
  PromptDefinitionSchema,
  type PromptDefinition,
} from "./schema.js";

const VALID_AGENT = {
  id: "triage",
  role: "triage" as const,
  description: "Classifies new tickets.",
  instructions: "Read the ticket, then classify it.",
  capabilities: ["ticket.create", "ticket.read"] as const,
  handoffs: ["diagnostic"],
};

function prompt(overrides: Partial<PromptDefinition>): PromptDefinition {
  return {
    id: "diagnose-ticket",
    description: "Diagnose a ticket.",
    agent: "diagnostic",
    template: "Diagnose ticket {{ticketId}}.",
    params: [{ name: "ticketId", kind: "single-token" }],
    ...overrides,
  };
}

describe("AgentDefinitionSchema", () => {
  it("accepts a well-formed agent definition", () => {
    expect(AgentDefinitionSchema.safeParse(VALID_AGENT).success).toBe(true);
  });

  it("rejects a non-kebab-case id", () => {
    const result = AgentDefinitionSchema.safeParse({ ...VALID_AGENT, id: "Triage_Agent" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown capability", () => {
    const result = AgentDefinitionSchema.safeParse({
      ...VALID_AGENT,
      capabilities: ["ticket.create", "ticket.delete"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown role", () => {
    const result = AgentDefinitionSchema.safeParse({ ...VALID_AGENT, role: "orchestrator" });
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognized extra field (strict object)", () => {
    const result = AgentDefinitionSchema.safeParse({ ...VALID_AGENT, tools: ["get_ticket"] });
    expect(result.success).toBe(false);
  });

  it("accepts an agent with no handoffs (escalation is a dead end)", () => {
    const result = AgentDefinitionSchema.safeParse({ ...VALID_AGENT, handoffs: [] });
    expect(result.success).toBe(true);
  });
});

describe("PromptDefinitionSchema", () => {
  it("accepts a well-formed prompt definition", () => {
    expect(PromptDefinitionSchema.safeParse(prompt({})).success).toBe(true);
  });

  it("rejects a non-kebab-case prompt id", () => {
    const result = PromptDefinitionSchema.safeParse(prompt({ id: "diagnoseTicket" }));
    expect(result.success).toBe(false);
  });

  it("rejects a param kind outside single-token/free-text", () => {
    const result = PromptDefinitionSchema.safeParse({
      ...prompt({}),
      params: [{ name: "ticketId", kind: "enum" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("McpServerDefinitionSchema", () => {
  it("accepts the fixed helpdesk server shape", () => {
    const result = McpServerDefinitionSchema.safeParse({
      name: "helpdesk",
      command: "npx",
      args: ["tsx", "src/app/mcp/main.ts"],
      env: ["HELPDESK_PSEUDONYM_KEY"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a different server name (the model has exactly one server)", () => {
    const result = McpServerDefinitionSchema.safeParse({
      name: "other",
      command: "npx",
      args: ["tsx", "src/app/mcp/main.ts"],
      env: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an env entry that looks like a value rather than a name (basic shape guard)", () => {
    const result = McpServerDefinitionSchema.safeParse({
      name: "helpdesk",
      command: "npx",
      args: ["tsx", "src/app/mcp/main.ts"],
      env: [""],
    });
    expect(result.success).toBe(false);
  });
});

describe("GeneratorModelSchema", () => {
  it("accepts a minimal well-formed model", () => {
    const result = GeneratorModelSchema.safeParse({
      agents: [VALID_AGENT],
      prompts: [prompt({})],
      mcpServer: {
        name: "helpdesk",
        command: "npx",
        args: ["tsx", "src/app/mcp/main.ts"],
        env: [],
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("extractPlaceholders", () => {
  it("extracts every {{param}} placeholder in order", () => {
    expect(extractPlaceholders("escalate {{ticketId}} because {{reason}}")).toEqual([
      "ticketId",
      "reason",
    ]);
  });

  it("returns an empty array for a template with no placeholders", () => {
    expect(extractPlaceholders("read-only prompt")).toEqual([]);
  });
});

describe("checkPromptTemplate", () => {
  it("passes when placeholders exactly match declared single-token params", () => {
    const errors = checkPromptTemplate(
      prompt({
        template: "escalate {{ticketId}} for {{reason}}",
        params: [
          { name: "ticketId", kind: "single-token" },
          { name: "reason", kind: "single-token" },
        ],
      }),
    );
    expect(errors).toEqual([]);
  });

  it("passes for a single free-text param", () => {
    const errors = checkPromptTemplate(
      prompt({ template: "file a ticket: {{description}}", params: [{ name: "description", kind: "free-text" }] }),
    );
    expect(errors).toEqual([]);
  });

  it("flags a placeholder with no declared param", () => {
    const errors = checkPromptTemplate(prompt({ template: "diagnose {{ticketId}} {{extra}}" }));
    expect(errors.some((e) => e.includes('"{{extra}}"'))).toBe(true);
  });

  it("flags a declared param with no placeholder in the template", () => {
    const errors = checkPromptTemplate(
      prompt({
        template: "diagnose {{ticketId}}",
        params: [
          { name: "ticketId", kind: "single-token" },
          { name: "unused", kind: "single-token" },
        ],
      }),
    );
    expect(errors.some((e) => e.includes('"unused"'))).toBe(true);
  });

  it("flags more than one free-text param", () => {
    const errors = checkPromptTemplate(
      prompt({
        template: "{{a}} {{b}}",
        params: [
          { name: "a", kind: "free-text" },
          { name: "b", kind: "free-text" },
        ],
      }),
    );
    expect(errors.some((e) => e.includes("at most one free-text parameter"))).toBe(true);
  });

  it("flags a free-text param mixed with another param", () => {
    const errors = checkPromptTemplate(
      prompt({
        template: "{{description}} {{ticketId}}",
        params: [
          { name: "description", kind: "free-text" },
          { name: "ticketId", kind: "single-token" },
        ],
      }),
    );
    expect(errors.some((e) => e.includes("only parameter"))).toBe(true);
  });
});
