import {
  checkPromptTemplate,
  GeneratorModelSchema,
  type AgentDefinition,
  type AgentRole,
  type Capability,
  type GeneratorModel,
} from "./definitions/schema.js";

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
 *
 * `model` is only trusted to be well-typed at compile time; it may in fact
 * be untrusted runtime data (a hand-edited definitions file, a future
 * loader). So the very first check is `GeneratorModelSchema.safeParse`,
 * which enforces everything zod can see on its own — kebab-case ids, the
 * `strict()` object shapes, the capability/role enums, the env var name
 * shape, and so on. The graph/template checks below (duplicate ids across
 * agents and prompts, unknown handoff/prompt targets, cycles, role
 * capability rules, placeholder/param matching) are cross-item rules zod
 * cannot express on a single object, so they still run separately — but
 * only once the schema parse itself succeeds. If it fails, this function
 * reports every schema violation and stops there rather than running the
 * graph checks over data it can no longer trust to have the right shape
 * (e.g. a `handoffs` field that isn't actually an array would crash
 * `Array.prototype.includes`, and any graph-level finding it could produce
 * would be redundant with the schema violation already collected).
 */
export function validateModel(model: GeneratorModel): ValidationResult {
  const errors: string[] = [];

  const parsed = GeneratorModelSchema.safeParse(model);
  if (!parsed.success) {
    errors.push(...parsed.error.issues.map(formatSchemaIssue));
    return { ok: false, errors, longestHandoffPath: 0 };
  }

  const validatedModel = parsed.data;
  const agentsById = new Map(validatedModel.agents.map((agent) => [agent.id, agent]));

  errors.push(...findDuplicateIds(validatedModel));
  errors.push(...findUnknownHandoffTargets(validatedModel.agents, agentsById));
  errors.push(...findUnknownPromptAgents(validatedModel));
  errors.push(...findSelfLoops(validatedModel.agents));
  errors.push(...findForbiddenCapabilityViolations(validatedModel.agents));
  for (const prompt of validatedModel.prompts) {
    errors.push(...checkPromptTemplate(prompt));
  }

  const cycle = detectHandoffCycle(validatedModel.agents);
  if (cycle) errors.push(cycle);

  const longestHandoffPath = cycle ? 0 : computeLongestHandoffPath(validatedModel.agents);

  return { ok: errors.length === 0, errors, longestHandoffPath };
}

function formatSchemaIssue(issue: { readonly path: readonly PropertyKey[]; readonly message: string }): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `schema violation at "${path}": ${issue.message}`;
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

/**
 * Role -> forbidden capabilities. Per the feature document's role
 * definitions, triage holds create/read/update/audit only, and escalation
 * explicitly "holds neither" `diagnostic.run` nor `remediation.apply` — the
 * same two capabilities triage must not hold. Keeping this as a table
 * (rather than a `role !== "triage"` special case) makes escalation's rule
 * a normal entry instead of a second, easy-to-forget check, and is the
 * natural place to add a future role's restrictions.
 */
const FORBIDDEN_CAPABILITIES_BY_ROLE: Readonly<Record<AgentRole, readonly Capability[]>> = {
  triage: ["diagnostic.run", "remediation.apply"],
  diagnostic: [],
  escalation: ["diagnostic.run", "remediation.apply"],
};

function findForbiddenCapabilityViolations(agents: readonly AgentDefinition[]): string[] {
  const errors: string[] = [];
  for (const agent of agents) {
    for (const forbidden of FORBIDDEN_CAPABILITIES_BY_ROLE[agent.role]) {
      if (agent.capabilities.includes(forbidden)) {
        errors.push(
          `agent "${agent.id}" has role "${agent.role}", which may not hold capability "${forbidden}"`,
        );
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
