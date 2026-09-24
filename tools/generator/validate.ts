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
 * Ids reserved for renderer-*synthesized* output that is never authored as
 * a real `AgentDefinition`/`PromptDefinition`: OpenCode's derived
 * `helpdesk-orchestrator` primary agent (`opencode-renderer.ts`) and Claude
 * Code's derived `helpdesk-run` driver command (`claude-code-renderer.ts`).
 * Neither renderer ever checks a real definition's id against these before
 * emitting its synthetic file, so a definition that reused one of these ids
 * would previously render to the exact same path as the synthetic file
 * (two different `RenderedFile`s, one path, silently overwriting each other
 * once written to disk). Exported as the single source of truth: both
 * `validateModel` below (which now rejects a colliding id before any file
 * is ever rendered) and the two renderers (which synthesize their path
 * segment from these exact values, never a separate hard-coded literal)
 * read from here.
 */
export const RESERVED_IDS = {
  opencodeOrchestratorAgentId: "helpdesk-orchestrator",
  claudeCodeDriverCommandId: "helpdesk-run",
} as const;

/**
 * Nominal brand for `ValidatedModel`: a plain `{ model, longestHandoffPath }`
 * object literal does not satisfy this type (it is missing the brand
 * property, and nothing outside this module can name
 * `VALIDATED_MODEL_BRAND` to add one), so `tsc` rejects any attempt to
 * construct a `ValidatedModel` other than through `assertValidated` below.
 * This is a compile-time guarantee only — the brand carries no runtime
 * value — enforced by `npm run typecheck`, not by anything checked at
 * render time.
 */
declare const VALIDATED_MODEL_BRAND: unique symbol;

/**
 * `validateModel`'s two outputs a renderer actually needs: the schema- and
 * graph-checked model itself, and the handoff graph's longest path (edges),
 * which the Claude Code and OpenCode renderers (tasks 6.8-6.9) use to state
 * their driver's numeric hard-stop bound. The nominal brand above is what
 * actually enforces the sentence this type's name promises: every
 * `ValidatedModel` in the codebase, test fixtures included, is produced by
 * `assertValidated`, never assembled ad hoc.
 */
export interface ValidatedModel {
  readonly model: GeneratorModel;
  readonly longestHandoffPath: number;
  readonly [VALIDATED_MODEL_BRAND]: true;
}

/**
 * The only way to construct a `ValidatedModel`. Runs `validateModel` and
 * throws (naming every violation) if it fails; otherwise returns the
 * validated model, asserting the nominal brand `ValidatedModel` requires.
 * The `as ValidatedModel` cast is confined to this one function — everywhere
 * else, TypeScript itself rejects a `{ model, longestHandoffPath }` literal
 * that skips this path.
 */
export function assertValidated(model: GeneratorModel): ValidatedModel {
  const result = validateModel(model);
  if (!result.ok) {
    throw new Error(`model failed validation: ${result.errors.join("; ")}`);
  }
  return { model, longestHandoffPath: result.longestHandoffPath } as ValidatedModel;
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
  errors.push(...findReservedIdViolations(validatedModel));
  errors.push(...findUnknownHandoffTargets(validatedModel.agents, agentsById));
  errors.push(...findUnknownPromptAgents(validatedModel));
  errors.push(...findSelfLoops(validatedModel.agents));
  errors.push(...findForbiddenCapabilityViolations(validatedModel.agents));
  errors.push(...findEntryAgentViolations(validatedModel.agents));
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

function findReservedIdViolations(model: GeneratorModel): string[] {
  const reserved = new Set<string>(Object.values(RESERVED_IDS));
  const errors: string[] = [];
  for (const agent of model.agents) {
    if (reserved.has(agent.id)) {
      errors.push(
        `agent id "${agent.id}" is reserved for generator-synthesized output and cannot be used by a definition`,
      );
    }
  }
  for (const prompt of model.prompts) {
    if (reserved.has(prompt.id)) {
      errors.push(
        `prompt id "${prompt.id}" is reserved for generator-synthesized output and cannot be used by a definition`,
      );
    }
  }
  return errors;
}

/**
 * The agent no other agent hands off to: the unique starting point the
 * Claude Code driver command and the OpenCode derived orchestrator both
 * assume (tasks 6.8-6.9). Exported so those renderers compute it through
 * this exact same function rather than each re-deriving it, and so their
 * own defensive check can never diverge from the rule `validateModel`
 * enforces below.
 */
export function findEntryAgents(agents: readonly AgentDefinition[]): readonly AgentDefinition[] {
  const targeted = new Set(agents.flatMap((agent) => agent.handoffs));
  return agents.filter((agent) => !targeted.has(agent.id));
}

/**
 * Rejects any model without exactly one entry agent. Before this rule
 * existed, a model with e.g. two independent handoff roots passed
 * `validateModel` successfully and only failed later, at render time, when
 * the Claude Code and OpenCode renderers' own `findEntryAgent` each threw —
 * making a renderer the first place an otherwise-valid-looking model's
 * actual shape problem surfaced. Running the same check here means an
 * invalid model is rejected before any file is ever rendered, with every
 * other violation reported alongside it.
 */
function findEntryAgentViolations(agents: readonly AgentDefinition[]): string[] {
  const entries = findEntryAgents(agents);
  if (entries.length === 1) return [];
  return [
    `expected exactly one entry agent (an agent no other agent hands off to, so a renderer knows where the driven sequence starts), found ${entries.length}: ${entries.map((a) => a.id).join(", ") || "none"}`,
  ];
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
