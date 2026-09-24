import type { PromptDefinition } from "./schema.js";

/**
 * The four shared prompts (feature document). Templates use the neutral
 * `{{param}}` syntax (ADR 0009); each platform renderer (task 6.7-6.9, PR B)
 * rewrites placeholders into its own variable syntax
 * (`${input:param}` for VS Code, `$1`/`$ARGUMENTS` for Claude Code and
 * OpenCode).
 *
 * Per ADR 0009's template contract, `new-ticket` has exactly one
 * (`free-text`) parameter, and every other prompt has only `single-token`
 * parameters — `escalate-ticket`'s `{{reason}}` is not free text: it is one
 * of the domain's `EscalationReason` values (see
 * `src/tickets/domain/ticket.ts`), a single token with no internal
 * whitespace, same as `{{ticketId}}`.
 */
export const PROMPTS: PromptDefinition[] = [
  {
    id: "new-ticket",
    description: "File a new help desk ticket from a free-text description and triage it.",
    agent: "triage",
    template:
      "A user reports the following issue: {{description}}\n\n" +
      "Call create_ticket with this text, then classify the resulting ticket " +
      "(category, subcategory, severity, urgency, affected user, impacted " +
      "service) and move it to Triaged.",
    params: [{ name: "description", kind: "free-text" }],
  },
  {
    id: "diagnose-ticket",
    description: "Diagnose a ticket's technical problem and remediate it if safe.",
    agent: "diagnostic",
    template:
      "Diagnose ticket {{ticketId}}. Read it first, then follow the " +
      "connectivity-diagnostic skill's procedure to run the appropriate " +
      "check, apply an allowlisted fix if the server decides one is safe, " +
      "or escalate.",
    params: [{ name: "ticketId", kind: "single-token" }],
  },
  {
    id: "escalate-ticket",
    description: "Escalate a ticket to a human team with a given escalation reason.",
    agent: "escalation",
    template:
      "Escalate ticket {{ticketId}} with escalation reason {{reason}}. Read " +
      "the ticket first, choose the right target team from its triage " +
      "category and subcategory, then record the escalation.",
    params: [
      { name: "ticketId", kind: "single-token" },
      { name: "reason", kind: "single-token" },
    ],
  },
  {
    id: "ticket-status",
    description: "Read-only: report a ticket's current state and triage data.",
    agent: "triage",
    template:
      "Read ticket {{ticketId}} and summarize its current state and triage " +
      "data in plain language. This is a read-only request: never " +
      "transition the ticket.",
    params: [{ name: "ticketId", kind: "single-token" }],
  },
];
