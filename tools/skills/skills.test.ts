import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ClientErrorCode } from "../../src/app/mcp/error-mapper.js";
import { TOOL_NAMES } from "../../src/app/mcp/tool-names.js";
import { RUNNER_FAILURE_REASONS } from "../../src/diagnostics/domain/runner-outcome.js";
import type { EscalationReason } from "../../src/tickets/domain/ticket.js";
import { EscalatedPayloadSchema } from "../../src/tickets/domain/transition-payloads.js";

/**
 * Contract tests for the hand-written Agent Skills under `.claude/skills/`
 * (ADR 0002: one shared copy read by VS Code, Claude Code and OpenCode).
 * Skills are Markdown, so nothing but these tests stops them from drifting
 * away from the MCP server they drive (ADR 0003): a renamed tool, a moved
 * script, or a new runner-failure / escalation reason must fail here until
 * the skill text is updated.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SKILLS_DIR = join(REPO_ROOT, ".claude", "skills");
const CONNECTIVITY_SKILL = "connectivity-diagnostic";
const CONNECTIVITY_REFERENCE = join("references", "diagnostic-report.md");

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

interface ParsedSkill {
  readonly frontmatter: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * Deliberately tiny frontmatter parser (no YAML dependency): a leading
 * `---` fence, one `key: value` scalar per line, a closing `---` fence.
 * Values may be wrapped in single or double quotes. Anything richer (lists,
 * block scalars) is rejected, which keeps skill frontmatter to the flat
 * `name`/`description` shape every target platform understands.
 */
function parseSkill(source: string): ParsedSkill {
  const normalized = source.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(normalized);
  if (!match) {
    throw new Error("SKILL.md must start with a '---' fenced frontmatter block");
  }
  const [, rawFrontmatter = "", body = ""] = match;
  const frontmatter: Record<string, string> = {};
  for (const line of rawFrontmatter.split("\n")) {
    if (line.trim() === "") continue;
    const entry = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!entry) {
      throw new Error(`unsupported frontmatter line: "${line}"`);
    }
    const [, key = "", rawValue = ""] = entry;
    const quoted = /^(["'])(.*)\1$/.exec(rawValue.trim());
    frontmatter[key] = quoted ? (quoted[2] ?? "") : rawValue.trim();
  }
  return { frontmatter, body };
}

function listSkillDirs(): string[] {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readSkill(dir: string): ParsedSkill {
  return parseSkill(readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf8"));
}

/** Every Markdown file a skill ships: `SKILL.md` plus `references/*.md`. */
function listSkillMarkdown(dir: string): string[] {
  const files = [join(SKILLS_DIR, dir, "SKILL.md")];
  const referencesDir = join(SKILLS_DIR, dir, "references");
  if (existsSync(referencesDir)) {
    for (const entry of readdirSync(referencesDir)) {
      if (entry.endsWith(".md")) files.push(join(referencesDir, entry));
    }
  }
  return files;
}

/**
 * The body of the `## <heading>` section (up to the next `## ` heading),
 * so a test can target one table without matching the same token
 * elsewhere in the document.
 */
function section(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) {
    throw new Error(`missing "## ${heading}" section`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** Backticked value of the first cell of every table row in `markdown`. */
function firstColumnValues(markdown: string): string[] {
  const values: string[] = [];
  for (const line of markdown.split("\n")) {
    const cell = /^\|\s*`([^`]+)`/.exec(line.trim());
    if (cell?.[1] !== undefined) values.push(cell[1]);
  }
  return values;
}

/** Backticked identifiers at the start of each `- ` bullet in `markdown`. */
function bulletIdentifiers(markdown: string): string[] {
  const values: string[] = [];
  for (const line of markdown.split("\n")) {
    const bullet = /^\s*-\s+`([^`]+)`/.exec(line);
    if (bullet?.[1] !== undefined) values.push(bullet[1]);
  }
  return values;
}

/**
 * Tool calls written in call shape inside backticks, e.g.
 * `` `run_diagnostic({ ... })` `` or `` `get_ticket(ticketId)` ``.
 * Snake_case values that are NOT calls (e.g. the failure reason
 * `` `nonzero_exit` ``) are intentionally not matched.
 */
function calledTools(markdown: string): string[] {
  return [...markdown.matchAll(/`([a-z]+(?:_[a-z]+)+)\(/g)].map((m) => m[1] as string);
}

/**
 * Repo-relative paths a skill points at: backticked
 * `scripts|src|config|docs/...` paths (resolved from the repo root) and
 * Markdown links to `references/...` (resolved from the skill directory).
 */
function referencedPaths(markdown: string): Array<{ readonly path: string; readonly base: "repo" | "skill" }> {
  const repoPaths = [
    ...markdown.matchAll(/`((?:scripts|src|config|docs|tools)\/[\w./-]+\.(?:ts|md|json))`/g),
  ].map((m) => ({ path: m[1] as string, base: "repo" as const }));
  const skillPaths = [...markdown.matchAll(/\]\((references\/[\w./-]+\.md)\)/g)].map((m) => ({
    path: m[1] as string,
    base: "skill" as const,
  }));
  return [...repoPaths, ...skillPaths];
}

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Compile-time proof that the runtime escalation reasons read from
 * `EscalatedPayloadSchema` are exactly the domain's `EscalationReason`
 * union, in both directions, so the drift test below compares against the
 * real domain vocabulary rather than a second hand-kept list.
 */
type SchemaEscalationReason = (typeof EscalatedPayloadSchema.shape.escalationReason.options)[number];
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const escalationReasonsMatchDomain: Equal<SchemaEscalationReason, EscalationReason> = true;
const ESCALATION_REASONS: readonly string[] = EscalatedPayloadSchema.shape.escalationReason.options;

describe("agent skills: frontmatter contract (.claude/skills/*/SKILL.md)", () => {
  const skillDirs = listSkillDirs();

  it("ships the connectivity-diagnostic skill", () => {
    expect(skillDirs).toContain(CONNECTIVITY_SKILL);
  });

  it.each(skillDirs)("%s: frontmatter parses with a kebab-case name equal to its directory", (dir) => {
    const { frontmatter } = readSkill(dir);
    expect(frontmatter["name"]).toBe(dir);
    expect(dir).toMatch(KEBAB_CASE);
    expect(dir.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
  });

  it.each(skillDirs)("%s: description is non-empty and at most 1024 characters", (dir) => {
    const description = readSkill(dir).frontmatter["description"] ?? "";
    expect(description.trim().length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
  });

  it.each(skillDirs)("%s: every declared and every called MCP tool exists in TOOL_NAMES", (dir) => {
    const { body } = readSkill(dir);
    const declared = bulletIdentifiers(section(body, "MCP tools"));
    expect(declared.length).toBeGreaterThan(0);
    for (const tool of declared) {
      expect(TOOL_NAMES, `declared tool "${tool}"`).toContain(tool);
    }
    for (const tool of calledTools(body)) {
      expect(declared, `called tool "${tool}" is not declared under "## MCP tools"`).toContain(tool);
    }
  });

  it.each(skillDirs)("%s: every referenced repo path and reference file exists", (dir) => {
    for (const file of listSkillMarkdown(dir)) {
      for (const ref of referencedPaths(readFileSync(file, "utf8"))) {
        const resolved = ref.base === "repo" ? join(REPO_ROOT, ref.path) : join(dirname(file), ref.path);
        expect(existsSync(resolved), `${file} references missing "${ref.path}"`).toBe(true);
      }
    }
  });

  it.each(skillDirs)("%s: every `npm run <script>` it documents exists in package.json", (dir) => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const file of listSkillMarkdown(dir)) {
      for (const m of readFileSync(file, "utf8").matchAll(/npm run ([\w:-]+)/g)) {
        expect(Object.keys(pkg.scripts), `${file} runs "npm run ${m[1]}"`).toContain(m[1]);
      }
    }
  });
});

describe("agent skills: connectivity-diagnostic procedure", () => {
  it("declares the diagnostic tool chain it drives", () => {
    const declared = bulletIdentifiers(section(readSkill(CONNECTIVITY_SKILL).body, "MCP tools"));
    expect(sorted(declared)).toEqual(
      sorted(["get_ticket", "run_diagnostic", "apply_remediation", "update_ticket", "append_audit"]),
    );
  });

  it("calls run_diagnostic with the connectivity probe and never supplies a host", () => {
    const { body } = readSkill(CONNECTIVITY_SKILL);
    expect(body).toMatch(/`run_diagnostic\(\{[^`]*probe: "connectivity"[^`]*\}\)`/);
    for (const call of body.matchAll(/`run_diagnostic\(([^`]*)\)`/g)) {
      expect(call[1]).not.toMatch(/host|target|url/i);
    }
  });

  it("links the DiagnosticReport reference for progressive disclosure", () => {
    expect(readSkill(CONNECTIVITY_SKILL).body).toContain(`](${CONNECTIVITY_REFERENCE})`);
  });
});

describe("agent skills: connectivity-diagnostic drift against domain enums", () => {
  const skillBody = (): string => readSkill(CONNECTIVITY_SKILL).body;
  const reference = (): string =>
    readFileSync(join(SKILLS_DIR, CONNECTIVITY_SKILL, CONNECTIVITY_REFERENCE), "utf8");

  it("the escalation reasons read from the domain schema match the EscalationReason type", () => {
    expect(escalationReasonsMatchDomain).toBe(true);
  });

  it("the reference documents exactly the domain's runner failure reasons", () => {
    expect(sorted(firstColumnValues(section(reference(), "Runner failure reasons")))).toEqual(
      sorted(RUNNER_FAILURE_REASONS),
    );
  });

  it("the reference documents exactly the domain's escalation reasons", () => {
    expect(sorted(firstColumnValues(section(reference(), "Escalation reasons")))).toEqual(
      sorted(ESCALATION_REASONS),
    );
  });

  it("the skill's failure handling table covers every runner failure reason and a missing diagnostic", () => {
    const rows = firstColumnValues(section(skillBody(), "Failure handling"));
    for (const reason of [...RUNNER_FAILURE_REASONS, "no_diagnostic_available"]) {
      expect(rows, `failure handling row for "${reason}"`).toContain(reason);
    }
  });

  it("the skill's failure handling table covers the MCP error codes the procedure can hit", () => {
    const rows = firstColumnValues(section(skillBody(), "Failure handling"));
    const codes = [
      "TICKET_NOT_FOUND",
      "ACTOR_NOT_PERMITTED",
      "DIAGNOSTIC_NOT_USABLE",
      "VALIDATION_ERROR",
      "NOT_ALLOWLISTED",
      "INVALID_TRANSITION",
      "CONFLICT",
      "INTERNAL_ERROR",
    ] as const satisfies readonly ClientErrorCode[];
    for (const code of codes) {
      expect(rows, `failure handling row for "${code}"`).toContain(code);
    }
  });
});
