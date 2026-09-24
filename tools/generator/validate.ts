import { checkPromptTemplate, type AgentDefinition, type GeneratorModel } from "./definitions/schema.js";

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  /**
   * Longest handoff path in the graph, counted in edges (e.g.
   * `triage -> diagnostic -> escalation` is 2). Meaningless (reported as
   * `0`) when the graph is cyclic — the Claude Code renderer (task 6.8,
   * PR B) only ever reads this after `ok` is `true`.
   */
  readonly longestHandoffPath: number;
}

/**
 * Validates a whole `GeneratorModel` before any file is emitted (ADR 0009:
 * "Any failure aborts the build with no files written"). Collects every
 * violation rather than stopping at the first one: a definitions author
 * fixing a batch of agents benefits from seeing every problem in one run,
 * the same way `applyTransition`'s `VALIDATION_ERROR` reports every zod
 * issue at once rather than one round-trip per field.
 */
export function validateModel(model: GeneratorModel): ValidationResult {
  const errors: string[] = [];
  const agentsById = new Map(model.agents.map((agent) => [agent.id, agent]));

  errors.push(...findDuplicateIds(model));
  errors.push(...findUnknownHandoffTargets(model.agents, agentsById));
  errors.push(...findUnknownPromptAgents(model));
  errors.push(...findSelfLoops(model.agents));
  errors.push(...findTriageCapabilityViolations(model.agents));
  for (const prompt of model.prompts) {
    errors.push(...checkPromptTemplate(prompt));
  }

  const cycle = detectHandoffCycle(model.agents);
  if (cycle) errors.push(cycle);

  const longestHandoffPath = cycle ? 0 : computeLongestHandoffPath(model.agents);

  return { ok: errors.length === 0, errors, longestHandoffPath };
}

function findDuplicateIds(model: GeneratorModel): string[] {
  const seen = new Map<string, string>(); // id -> kind of the first owner
  const errors: string[] = [];
  for (const agent of model.agents) {
    recordId(seen, errors, agent.id, "agent");
  }
  for (const prompt of model.prompts) {
    recordId(seen, errors, prompt.id, "prompt");
  }
  return errors;
}

function recordId(seen: Map<string, string>, errors: string[], id: string, kind: "agent" | "prompt"): void {
  const existingKind = seen.get(id);
  if (existingKind !== undefined) {
    errors.push(`duplicate id "${id}": declared as both a ${existingKind} and a ${kind}`);
    return;
  }
  seen.set(id, kind);
}

function findUnknownHandoffTargets(
  agents: readonly AgentDefinition[],
  agentsById: ReadonlyMap<string, AgentDefinition>,
): string[] {
  const errors: string[] = [];
  for (const agent of agents) {
    for (const target of agent.handoffs) {
      if (!agentsById.has(target)) {
        errors.push(`agent "${agent.id}" hands off to unknown agent "${target}"`);
      }
    }
  }
  return errors;
}

function findUnknownPromptAgents(model: GeneratorModel): string[] {
  const agentsById = new Map(model.agents.map((agent) => [agent.id, agent]));
  const errors: string[] = [];
  for (const prompt of model.prompts) {
    if (!agentsById.has(prompt.agent)) {
      errors.push(`prompt "${prompt.id}" refers to unknown agent "${prompt.agent}"`);
    }
  }
  return errors;
}

function findSelfLoops(agents: readonly AgentDefinition[]): string[] {
  const errors: string[] = [];
  for (const agent of agents) {
    if (agent.handoffs.includes(agent.id)) {
      errors.push(`agent "${agent.id}" has a self-loop handoff to itself`);
    }
  }
  return errors;
}

const TRIAGE_FORBIDDEN_CAPABILITIES = ["diagnostic.run", "remediation.apply"] as const;

function findTriageCapabilityViolations(agents: readonly AgentDefinition[]): string[] {
  const errors: string[] = [];
  for (const agent of agents) {
    if (agent.role !== "triage") continue;
    for (const forbidden of TRIAGE_FORBIDDEN_CAPABILITIES) {
      if (agent.capabilities.includes(forbidden)) {
        errors.push(`triage agent "${agent.id}" may not hold capability "${forbidden}"`);
      }
    }
  }
  return errors;
}

/**
 * DFS with an explicit path stack (white/gray/black coloring). Returns one
 * error message naming the full cycle (e.g. `"handoff cycle: a -> b -> a"`)
 * the first time a back-edge to an in-progress node is found, or `null`
 * when the graph is acyclic. Unknown handoff targets (already reported by
 * `findUnknownHandoffTargets`) are simply not visited further, so a
 * dangling handoff never crashes cycle detection.
 */
function detectHandoffCycle(agents: readonly AgentDefinition[]): string | null {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];

  function visit(id: string): string | null {
    state.set(id, "visiting");
    path.push(id);

    const agent = agentsById.get(id);
    if (agent) {
      for (const target of agent.handoffs) {
        if (state.get(target) === "visiting") {
          const cycleStart = path.indexOf(target);
          const cyclePath = [...path.slice(cycleStart), target];
          return `handoff cycle: ${cyclePath.join(" -> ")}`;
        }
        if (state.get(target) !== "done" && agentsById.has(target)) {
          const found = visit(target);
          if (found) return found;
        }
      }
    }

    path.pop();
    state.set(id, "done");
    return null;
  }

  for (const agent of agents) {
    if (state.get(agent.id) !== "done") {
      const found = visit(agent.id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Longest path in the (assumed acyclic) handoff graph, counted in edges.
 * Memoized DFS: each node's longest path is `1 + max(longest path of its
 * targets)`, `0` for a dead end. Safe to call only once `detectHandoffCycle`
 * has confirmed the graph is acyclic (otherwise this could not terminate).
 */
function computeLongestHandoffPath(agents: readonly AgentDefinition[]): number {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const memo = new Map<string, number>();

  function longestFrom(id: string): number {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const agent = agentsById.get(id);
    let longest = 0;
    if (agent) {
      for (const target of agent.handoffs) {
        if (!agentsById.has(target)) continue; // unknown target, already reported
        longest = Math.max(longest, 1 + longestFrom(target));
      }
    }
    memo.set(id, longest);
    return longest;
  }

  let overall = 0;
  for (const agent of agents) {
    overall = Math.max(overall, longestFrom(agent.id));
  }
  return overall;
}
