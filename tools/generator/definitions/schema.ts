import { z } from "zod";

/**
 * zod-typed source of truth for the platform customization generator (ADR
 * 0009). Agents declare abstract capabilities here, never platform tool
 * names or MCP prefixes — the capability -> MCP tool name map lives in
 * `tools/generator/capabilities.ts`, which imports `Capability` from this
 * module (never the other way around), so this file has zero dependency on
 * `src/`.
 */

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Shared by agent and prompt ids: kebab-case, unique across both (ADR 0009). */
export const KebabIdSchema = z
  .string()
  .regex(KEBAB_CASE, "id must be kebab-case (lowercase letters, digits, single hyphens)");

/**
 * Only the three roles the shared definitions ever declare. The feature
 * document's OpenCode-only `helpdesk-orchestrator` is synthesized entirely
 * by the OpenCode renderer (task 6.9, PR B) from the validated handoff
 * graph — it is never authored as an `AgentDefinition`, so it has no role
 * value here. Keeping the enum to the three real actors also matches
 * `AGENT_ACTORS` in `src/tickets/domain/ticket.ts`.
 */
export const AgentRoleSchema = z.enum(["triage", "diagnostic", "escalation"]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/**
 * Abstract capabilities an agent may hold. Deliberately business-shaped
 * (`ticket.read`, not `get_ticket`): renderers translate a capability into
 * one or more platform-prefixed MCP tool names via
 * `tools/generator/capabilities.ts`, so no definition ever names a tool.
 */
export const CAPABILITIES = [
  "ticket.create",
  "ticket.read",
  "ticket.update",
  "audit.append",
  "diagnostic.run",
  "remediation.apply",
] as const;
export const CapabilitySchema = z.enum(CAPABILITIES);
export type Capability = (typeof CAPABILITIES)[number];

/**
 * An agent's handoffs are a list of target agent ids. Per ADR 0009 the
 * handoff contract passes only `ticketId` — there is no per-handoff
 * parameter to declare, so a plain id list is the whole shape.
 */
export const AgentDefinitionSchema = z
  .object({
    id: KebabIdSchema,
    role: AgentRoleSchema,
    description: z.string().min(1),
    instructions: z.string().min(1),
    capabilities: z.array(CapabilitySchema).min(1),
    handoffs: z.array(KebabIdSchema),
  })
  .strict();
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/**
 * A prompt parameter is either the prompt's one free-text field (arbitrary,
 * possibly multi-word text, e.g. a ticket description) or a single-token
 * field (an id or an enum-like value with no internal whitespace, e.g.
 * `ticketId` or an `EscalationReason`). The template parser below enforces
 * ADR 0009's rule from this `kind` tag: "either exactly one free-text
 * parameter, or only single-token parameters."
 */
export const PromptParamSchema = z.discriminatedUnion("kind", [
  z.object({ name: z.string().min(1), kind: z.literal("single-token") }).strict(),
  z.object({ name: z.string().min(1), kind: z.literal("free-text") }).strict(),
]);
export type PromptParam = z.infer<typeof PromptParamSchema>;

export const PromptDefinitionSchema = z
  .object({
    id: KebabIdSchema,
    description: z.string().min(1),
    agent: KebabIdSchema,
    template: z.string().min(1),
    params: z.array(PromptParamSchema),
  })
  .strict();
export type PromptDefinition = z.infer<typeof PromptDefinitionSchema>;

/** An environment variable *name* (`HELPDESK_PSEUDONYM_KEY`), never a value or a `NAME=value` assignment. */
const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * The one MCP server every platform launches (feature document, decision
 * user-approved 2026-09-24: `npx tsx src/app/mcp/main.ts`). `env` lists
 * only environment variable *names* to pass through per-platform
 * interpolation (e.g. `HELPDESK_PSEUDONYM_KEY`) — never a value, so no
 * secret can ever be committed through this model. Each entry must match
 * `ENV_VAR_NAME_RE` (SCREAMING_SNAKE_CASE), which rejects a `NAME=value`
 * assignment or a raw secret string as firmly as it rejects an empty entry.
 */
export const McpServerDefinitionSchema = z
  .object({
    name: z.literal("helpdesk"),
    command: z.literal("npx"),
    args: z.tuple([z.literal("tsx"), z.literal("src/app/mcp/main.ts")]),
    env: z.array(z.string().regex(ENV_VAR_NAME_RE, "env entry must be an ENV_VAR_NAME (e.g. HELPDESK_PSEUDONYM_KEY), never a value or NAME=value assignment")),
  })
  .strict();
export type McpServerDefinition = z.infer<typeof McpServerDefinitionSchema>;

export const GeneratorModelSchema = z
  .object({
    agents: z.array(AgentDefinitionSchema),
    prompts: z.array(PromptDefinitionSchema),
    mcpServer: McpServerDefinitionSchema,
  })
  .strict();
export type GeneratorModel = z.infer<typeof GeneratorModelSchema>;

/** Matches a valid `{{param}}` placeholder; the captured group is the param name. */
const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

/**
 * Matches a maximal run of consecutive `{` or consecutive `}` characters.
 * `findMalformedPlaceholders` below walks these runs in pairs (an opening
 * run followed by a closing run) rather than matching `\{\{...\}\}`
 * directly: a fixed two-brace regex either misses an extra brace around an
 * otherwise valid name (`{{{ticketId}}}`, a 3-run open paired with a 3-run
 * close) or misses an unclosed span entirely (`{{ticketId}`, a 2-run open
 * paired with only a 1-run close never matches `\{\{[^{}]*\}\}`'s required
 * two closing braces, so it silently falls through as literal text).
 * Comparing each pair's actual run *lengths* (not just requiring exactly
 * two braces up front) is what catches both.
 */
const BRACE_RUN_RE = /\{+|\}+/g;
const VALID_PLACEHOLDER_NAME_RE = /^\w+$/;

/** Every `{{param}}` placeholder found in `template`, in order of appearance (duplicates kept). */
export function extractPlaceholders(template: string): readonly string[] {
  return [...template.matchAll(PLACEHOLDER_RE)].map((match) => match[1] as string);
}

/**
 * Every `{{...}}`-shaped span in `template` that is not a well-formed
 * `{{name}}` placeholder, returned as the full offending text (e.g.
 * `"{{ticket-id}}"`, `"{{{ticketId}}}"`, `"{{ticketId}"`). Also flags a
 * stray opening run with no closing run at all, and a stray closing run
 * with no still-open opening run before it.
 */
function findMalformedPlaceholders(template: string): readonly string[] {
  const malformed: string[] = [];
  const runs = [...template.matchAll(BRACE_RUN_RE)];

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i] as RegExpMatchArray;
    const openRun = run[0] as string;

    if (openRun.startsWith("}")) {
      // A closing run with no unpaired opening run before it.
      malformed.push(openRun);
      continue;
    }

    const next = runs[i + 1] as RegExpMatchArray | undefined;
    const closeRun = next?.[0] as string | undefined;
    if (!next || !closeRun?.startsWith("}")) {
      // An opening run with nothing (or another opening run) after it.
      malformed.push(openRun);
      continue;
    }

    const contentStart = (run.index as number) + openRun.length;
    const contentEnd = next.index as number;
    const content = template.slice(contentStart, contentEnd);
    const span = template.slice(run.index as number, contentEnd + closeRun.length);

    if (openRun.length !== 2 || closeRun.length !== 2 || !VALID_PLACEHOLDER_NAME_RE.test(content)) {
      malformed.push(span);
    }
    i++; // this pair's closing run is consumed; do not re-visit it on its own
  }

  return malformed;
}

/**
 * Checks one prompt's template against its declared `params`, per ADR
 * 0009's template contract:
 *
 *  1. every `{{...}}` span in `template` is a well-formed single-word
 *     placeholder (no internal spaces, hyphens or other punctuation),
 *  2. the set of `{{param}}` placeholders in `template` equals the set of
 *     declared param names (both directions — an undeclared placeholder
 *     and an unused declared param are both errors),
 *  3. no param name is declared more than once (renderers map params by
 *     position, so a duplicate name is ambiguous), and
 *  4. either exactly one free-text parameter (and it is the prompt's only
 *     parameter), or every parameter is single-token.
 *
 * Returns all violations found (never throws) so `validate.ts` can fold
 * this into the model-wide error list.
 */
export function checkPromptTemplate(prompt: PromptDefinition): readonly string[] {
  const errors: string[] = [];

  for (const malformed of findMalformedPlaceholders(prompt.template)) {
    errors.push(
      `prompt "${prompt.id}": malformed placeholder ${malformed} (a placeholder must be a single word, e.g. "{{ticketId}}", with no spaces, hyphens or punctuation)`,
    );
  }

  const placeholders = new Set(extractPlaceholders(prompt.template));
  const paramNames = prompt.params.map((param) => param.name);
  const declared = new Set(paramNames);

  if (declared.size !== paramNames.length) {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const name of paramNames) {
      if (seen.has(name)) duplicates.add(name);
      seen.add(name);
    }
    for (const name of duplicates) {
      errors.push(
        `prompt "${prompt.id}": duplicate declared param "${name}" (renderers map params by position, so a duplicate name is ambiguous)`,
      );
    }
  }

  for (const placeholder of placeholders) {
    if (!declared.has(placeholder)) {
      errors.push(
        `prompt "${prompt.id}": template placeholder "{{${placeholder}}}" has no matching declared param`,
      );
    }
  }
  for (const name of declared) {
    if (!placeholders.has(name)) {
      errors.push(`prompt "${prompt.id}": declared param "${name}" has no "{{${name}}}" placeholder in the template`);
    }
  }

  const freeTextParams = prompt.params.filter((param) => param.kind === "free-text");
  if (freeTextParams.length > 1) {
    errors.push(
      `prompt "${prompt.id}": at most one free-text parameter is allowed, found ${freeTextParams.length}`,
    );
  } else if (freeTextParams.length === 1 && prompt.params.length > 1) {
    errors.push(
      `prompt "${prompt.id}": a free-text parameter must be the prompt's only parameter (found ${prompt.params.length} params)`,
    );
  }

  return errors;
}
