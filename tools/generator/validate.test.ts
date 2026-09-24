import { describe, expect, it } from "vitest";
import type { AgentDefinition, GeneratorModel, PromptDefinition } from "./definitions/schema.js";
import { validateModel } from "./validate.js";

const MCP_SERVER: GeneratorModel["mcpServer"] = {
  name: "helpdesk",
  command: "npx",
  args: ["tsx", "src/app/mcp/main.ts"],
  env: [],
};

function agent(overrides: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: "triage",
    role: "triage",
    description: "d",
    instructions: "i",
    capabilities: ["ticket.create"],
    handoffs: [],
    ...overrides,
  };
}

function prompt(overrides: Partial<PromptDefinition>): PromptDefinition {
  return {
    id: "new-ticket",
    description: "d",
    agent: "triage",
    template: "{{description}}",
    params: [{ name: "description", kind: "free-text" }],
    ...overrides,
  };
}

function model(overrides: Partial<GeneratorModel>): GeneratorModel {
  return {
    agents: [agent({})],
    prompts: [],
    mcpServer: MCP_SERVER,
    ...overrides,
  };
}

describe("validateModel: table-driven rule checks", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly model: GeneratorModel;
    readonly expectOk: boolean;
    readonly errorIncludes?: string;
  }> = [
    {
      name: "a single valid agent, no prompts",
      model: model({}),
      expectOk: true,
    },
    {
      name: "duplicate agent ids",
      model: model({ agents: [agent({ id: "triage" }), agent({ id: "triage", role: "diagnostic" })] }),
      expectOk: false,
      errorIncludes: "duplicate id",
    },
    {
      name: "an agent id and a prompt id collide (ids are unique across both)",
      model: model({
        agents: [agent({ id: "triage" })],
        prompts: [prompt({ id: "triage" })],
      }),
      expectOk: false,
      errorIncludes: "duplicate id",
    },
    {
      name: "handoff to an unknown agent",
      model: model({ agents: [agent({ id: "triage", handoffs: ["ghost"] })] }),
      expectOk: false,
      errorIncludes: "unknown agent",
    },
    {
      name: "prompt.agent refers to an unknown agent",
      model: model({ prompts: [prompt({ agent: "ghost" })] }),
      expectOk: false,
      errorIncludes: "unknown agent",
    },
    {
      name: "a self-loop handoff",
      model: model({ agents: [agent({ id: "triage", handoffs: ["triage"] })] }),
      expectOk: false,
      errorIncludes: "self-loop",
    },
    {
      name: "a 2-cycle handoff graph",
      model: model({
        agents: [
          agent({ id: "a", handoffs: ["b"] }),
          agent({ id: "b", role: "diagnostic", handoffs: ["a"] }),
        ],
      }),
      expectOk: false,
      errorIncludes: "handoff cycle",
    },
    {
      name: "a 3-cycle handoff graph names the full path",
      model: model({
        agents: [
          agent({ id: "a", handoffs: ["b"] }),
          agent({ id: "b", role: "diagnostic", handoffs: ["c"] }),
          agent({ id: "c", role: "escalation", handoffs: ["a"] }),
        ],
      }),
      expectOk: false,
      errorIncludes: "handoff cycle: a -> b -> c -> a",
    },
    {
      name: "triage holding diagnostic.run",
      model: model({ agents: [agent({ id: "triage", capabilities: ["diagnostic.run"] })] }),
      expectOk: false,
      errorIncludes: "diagnostic.run",
    },
    {
      name: "triage holding remediation.apply",
      model: model({ agents: [agent({ id: "triage", capabilities: ["remediation.apply"] })] }),
      expectOk: false,
      errorIncludes: "remediation.apply",
    },
    {
      name: "escalation holding diagnostic.run",
      model: model({
        agents: [agent({ id: "escalation", role: "escalation", capabilities: ["diagnostic.run"] })],
      }),
      expectOk: false,
      errorIncludes: "diagnostic.run",
    },
    {
      name: "escalation holding remediation.apply",
      model: model({
        agents: [agent({ id: "escalation", role: "escalation", capabilities: ["remediation.apply"] })],
      }),
      expectOk: false,
      errorIncludes: "remediation.apply",
    },
    {
      name: "diagnostic holding diagnostic.run and remediation.apply is fine",
      model: model({
        agents: [agent({ id: "diagnostic", role: "diagnostic", capabilities: ["diagnostic.run", "remediation.apply"] })],
      }),
      expectOk: true,
    },
    {
      name: "an invalid prompt template (placeholder/param mismatch) fails validation too",
      model: model({
        prompts: [prompt({ template: "{{ticketId}}", params: [{ name: "ticketId", kind: "single-token" }, { name: "extra", kind: "single-token" }] })],
      }),
      expectOk: false,
      errorIncludes: "extra",
    },
  ];

  it.each(cases)("$name", ({ model: m, expectOk, errorIncludes }) => {
    const result = validateModel(m);
    expect(result.ok).toBe(expectOk);
    if (!expectOk) {
      expect(result.errors.length).toBeGreaterThan(0);
      if (errorIncludes) {
        expect(result.errors.some((e) => e.includes(errorIncludes))).toBe(true);
      }
    } else {
      expect(result.errors).toEqual([]);
    }
  });
});

describe("validateModel: runs the zod schema before the graph/template checks", () => {
  it("reports a non-kebab-case agent id as a schema violation", () => {
    const result = validateModel(model({ agents: [agent({ id: "Triage_Agent" })] }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("schema violation"))).toBe(true);
    expect(result.errors.some((e) => e.includes("kebab-case"))).toBe(true);
  });

  it("skips the graph/template checks once the schema itself fails, rather than trusting untyped data", () => {
    // This agent is both schema-invalid (bad id) AND would trip the
    // self-loop graph check if that check ran on it. Only the schema
    // violation should be reported: once the model fails its own shape
    // check, the graph checks below assume well-typed data they no longer
    // have, so validateModel does not run them.
    const result = validateModel(model({ agents: [agent({ id: "Bad_Id", handoffs: ["Bad_Id"] })] }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("schema violation"))).toBe(true);
    expect(result.errors.some((e) => e.includes("self-loop"))).toBe(false);
    expect(result.longestHandoffPath).toBe(0);
  });

  it("still runs the graph checks when every agent/prompt is individually schema-valid (existing collect-all-errors behavior)", () => {
    // Duplicate ids, unknown handoff targets, cycles etc. are not shape
    // violations zod can see (each agent/prompt is individually valid) -
    // they are cross-item graph rules validateModel must still enforce.
    const result = validateModel(
      model({
        agents: [agent({ id: "triage", handoffs: ["ghost"] }), agent({ id: "triage", role: "diagnostic" })],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("duplicate id"))).toBe(true);
    expect(result.errors.some((e) => e.includes("unknown agent"))).toBe(true);
    expect(result.errors.some((e) => e.includes("schema violation"))).toBe(false);
  });
});

describe("validateModel: collects every violation rather than failing on the first", () => {
  it("reports both a duplicate id and an unknown handoff target in one call", () => {
    const result = validateModel(
      model({
        agents: [
          agent({ id: "triage", handoffs: ["ghost"] }),
          agent({ id: "triage", role: "diagnostic" }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("duplicate id"))).toBe(true);
    expect(result.errors.some((e) => e.includes("unknown agent"))).toBe(true);
  });
});

describe("validateModel: longestHandoffPath", () => {
  it("is 0 for agents with no handoffs", () => {
    expect(validateModel(model({})).longestHandoffPath).toBe(0);
  });

  it("is 1 for a single a -> b handoff", () => {
    const result = validateModel(
      model({
        agents: [agent({ id: "a", handoffs: ["b"] }), agent({ id: "b", role: "diagnostic" })],
      }),
    );
    expect(result.longestHandoffPath).toBe(1);
  });

  it("is 2 for a -> b -> c", () => {
    const result = validateModel(
      model({
        agents: [
          agent({ id: "a", handoffs: ["b"] }),
          agent({ id: "b", role: "diagnostic", handoffs: ["c"] }),
          agent({ id: "c", role: "escalation" }),
        ],
      }),
    );
    expect(result.longestHandoffPath).toBe(2);
  });

  it("takes the longer of two branches (a -> b -> c and a -> c)", () => {
    const result = validateModel(
      model({
        agents: [
          agent({ id: "a", handoffs: ["b", "c"] }),
          agent({ id: "b", role: "diagnostic", handoffs: ["c"] }),
          agent({ id: "c", role: "escalation" }),
        ],
      }),
    );
    expect(result.longestHandoffPath).toBe(2);
  });
});
