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

/**
 * The one MCP server every platform launches (feature document, decision
 * user-approved 2026-09-24: `npx tsx src/app/mcp/main.ts`). `env` lists
 * only environment variable *names* to pass through per-platform
 * interpolation (e.g. `HELPDESK_PSEUDONYM_KEY`) — never a value, so no
 * secret can ever be committed through this model.
 */
export const McpServerDefinitionSchema = z
  .object({
    name: z.literal("helpdesk"),
    command: z.literal("npx"),
    args: z.tuple([z.literal("tsx"), z.literal("src/app/mcp/main.ts")]),
    env: z.array(z.string().min(1)),
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

/** Matches a `{{param}}` placeholder; the captured group is the param name. */
const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

/** Every `{{param}}` placeholder found in `template`, in order of appearance (duplicates kept). */
export function extractPlaceholders(template: string): readonly string[] {
  return [...template.matchAll(PLACEHOLDER_RE)].map((match) => match[1] as string);
}

/**
 * Checks one prompt's template against its declared `params`, per ADR
 * 0009's template contract:
 *
 *  1. the set of `{{param}}` placeholders in `template` equals the set of
 *     declared param names (both directions — an undeclared placeholder
 *     and an unused declared param are both errors), and
 *  2. either exactly one free-text parameter (and it is the prompt's only
 *     parameter), or every parameter is single-token.
 *
 * Returns all violations found (never throws) so `validate.ts` can fold
 * this into the model-wide error list.
 */
export function checkPromptTemplate(prompt: PromptDefinition): readonly string[] {
  const errors: string[] = [];
  const placeholders = new Set(extractPlaceholders(prompt.template));
  const declared = new Set(prompt.params.map((param) => param.name));

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
