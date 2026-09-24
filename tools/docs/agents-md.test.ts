import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EscalationReason } from "../../src/tickets/domain/ticket.js";
import { STATE_RANK, type TicketState } from "../../src/tickets/domain/states.js";
import { EscalatedPayloadSchema } from "../../src/tickets/domain/transition-payloads.js";
import { TRANSITION_RULES } from "../../src/tickets/domain/transitions.js";

/**
 * Drift test for the hand-authored `AGENTS.md` (PDF §2.1, ADR 0002:
 * `AGENTS.md` is the single source of custom instructions, read natively by
 * VS Code and OpenCode). Markdown has no compiler, so nothing but this test
 * stops the documented ticket lifecycle from silently disagreeing with the
 * domain rules the MCP server actually enforces (ADR 0003).
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const AGENTS_MD_PATH = join(REPO_ROOT, "AGENTS.md");

function readAgentsMd(): string {
  return readFileSync(AGENTS_MD_PATH, "utf8");
}

/** The body of the `## <heading>` or `### <heading>` section, up to the
 *  next heading of the same or a higher level. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const startPattern = new RegExp(`^(#{2,4})\\s+${heading}\\s*$`);
  const startIndex = lines.findIndex((line) => startPattern.test(line.trim()));
  if (startIndex < 0) {
    throw new Error(`AGENTS.md is missing a "${heading}" heading`);
  }
  const level = (startPattern.exec(lines[startIndex]!.trim()) as RegExpExecArray)[1]!.length;
  const rest = lines.slice(startIndex + 1);
  const endIndex = rest.findIndex((line) => new RegExp(`^#{2,${level}}\\s+`).test(line));
  return (endIndex < 0 ? rest : rest.slice(0, endIndex)).join("\n");
}

interface DocumentedTransition {
  readonly from: string;
  readonly to: string;
  readonly actors: readonly string[];
}

/** Parses the `| \`From\` | \`To\` | \`actor\`, \`actor\` | ... |` rows of
 *  the "Transition table" section. Extra columns (required/optional
 *  fields) are ignored here; only from/to/actors are load-bearing for the
 *  handoff/permission drift check. */
function parseTransitionTable(markdown: string): DocumentedTransition[] {
  const rows: DocumentedTransition[] = [];
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    const match = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*([^|]+)\|/.exec(trimmed);
    if (!match) continue;
    const [, from, to, actorsCell] = match as unknown as [string, string, string, string];
    const actors = [...actorsCell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
    if (actors.length === 0) continue;
    rows.push({ from, to, actors });
  }
  return rows;
}

/** Every backticked token anywhere in the document (used to check that a
 *  state name or escalation reason is mentioned at least once). */
function backtickedTokens(markdown: string): Set<string> {
  return new Set([...markdown.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string));
}

describe("AGENTS.md: ticket lifecycle drift against the domain (src/tickets/domain)", () => {
  it("exists at the repo root", () => {
    expect(() => readAgentsMd()).not.toThrow();
  });

  it("the Transition table section matches TRANSITION_RULES exactly (from, to, actors)", () => {
    const documented = parseTransitionTable(section(readAgentsMd(), "Transition table"));
    const actual = TRANSITION_RULES.map((rule) => ({
      from: rule.from,
      to: rule.to,
      actors: [...rule.actors],
    }));
    expect(documented).toEqual(actual);
  });

  it("mentions every ticket state defined in src/tickets/domain/states.ts", () => {
    const tokens = backtickedTokens(readAgentsMd());
    const states = Object.keys(STATE_RANK) as TicketState[];
    for (const state of states) {
      expect(tokens, `AGENTS.md does not mention state "${state}"`).toContain(state);
    }
  });

  it("mentions every escalation reason defined in the domain schema", () => {
    const tokens = backtickedTokens(readAgentsMd());
    const reasons: readonly EscalationReason[] = EscalatedPayloadSchema.shape.escalationReason
      .options as readonly EscalationReason[];
    for (const reason of reasons) {
      expect(tokens, `AGENTS.md does not mention escalation reason "${reason}"`).toContain(reason);
    }
  });
});
