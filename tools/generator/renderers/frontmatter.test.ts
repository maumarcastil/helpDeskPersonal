import { describe, expect, it } from "vitest";
import { renderFrontmatterFile, toFrontmatter } from "./frontmatter.js";

describe("toFrontmatter: scalars", () => {
  it("renders a plain string unquoted when it needs no quoting", () => {
    expect(toFrontmatter({ name: "triage" })).toBe("name: triage");
  });

  it("renders a boolean without quotes", () => {
    expect(toFrontmatter({ send: false })).toBe("send: false");
    expect(toFrontmatter({ send: true })).toBe("send: true");
  });

  it("omits a field whose value is undefined", () => {
    expect(toFrontmatter({ name: "triage", model: undefined })).toBe("name: triage");
  });

  it("preserves field declaration order", () => {
    expect(toFrontmatter({ b: "second", a: "first" })).toBe("b: second\na: first");
  });
});

describe("toFrontmatter: string quoting and escaping", () => {
  it("quotes an empty string", () => {
    expect(toFrontmatter({ description: "" })).toBe('description: ""');
  });

  it("quotes a string containing a colon-space (would otherwise start a mapping)", () => {
    expect(toFrontmatter({ description: "Note: read first" })).toBe('description: "Note: read first"');
  });

  it("quotes a string that looks like a YAML boolean or null keyword", () => {
    expect(toFrontmatter({ value: "true" })).toBe('value: "true"');
    expect(toFrontmatter({ value: "null" })).toBe('value: "null"');
  });

  it("quotes a string that looks like a number", () => {
    expect(toFrontmatter({ value: "42" })).toBe('value: "42"');
  });

  it("quotes a string starting with a YAML indicator character", () => {
    expect(toFrontmatter({ value: "- dash" })).toBe('value: "- dash"');
    expect(toFrontmatter({ value: "*star" })).toBe('value: "*star"');
    expect(toFrontmatter({ value: "#hash" })).toBe('value: "#hash"');
  });

  it("quotes and escapes a string containing a double quote and a backslash", () => {
    expect(toFrontmatter({ value: 'say "hi" \\ ok' })).toBe('value: "say \\"hi\\" \\\\ ok"');
  });

  it("quotes and escapes a string containing a newline", () => {
    expect(toFrontmatter({ value: "line one\nline two" })).toBe('value: "line one\\nline two"');
  });

  it("does not quote ordinary prose with commas, parentheses and periods", () => {
    expect(toFrontmatter({ description: "Classifies a new ticket (triage), then routes it." })).toBe(
      'description: Classifies a new ticket (triage), then routes it.',
    );
  });
});

describe("toFrontmatter: string lists", () => {
  it("renders a non-empty string array as a block sequence", () => {
    expect(toFrontmatter({ tools: ["helpdesk/get_ticket", "helpdesk/update_ticket"] })).toBe(
      "tools:\n  - helpdesk/get_ticket\n  - helpdesk/update_ticket",
    );
  });

  it("renders an empty array as a flow empty sequence", () => {
    expect(toFrontmatter({ tools: [] })).toBe("tools: []");
  });

  it("quotes an unsafe item inside a string list", () => {
    expect(toFrontmatter({ tools: ["ok", "unsafe: value"] })).toBe(
      'tools:\n  - ok\n  - "unsafe: value"',
    );
  });
});

describe("toFrontmatter: list of mappings (handoffs)", () => {
  it("renders each mapping's fields aligned under its own '- ' bullet", () => {
    const result = toFrontmatter({
      handoffs: [
        { label: "Hand off to diagnostic", agent: "diagnostic", prompt: "Continue.", send: false },
        { label: "Hand off to escalation", agent: "escalation", prompt: "Escalate.", send: false },
      ],
    });
    expect(result).toBe(
      [
        "handoffs:",
        "  - label: Hand off to diagnostic",
        "    agent: diagnostic",
        "    prompt: Continue.",
        "    send: false",
        "  - label: Hand off to escalation",
        "    agent: escalation",
        "    prompt: Escalate.",
        "    send: false",
      ].join("\n"),
    );
  });
});

describe("toFrontmatter: nested mappings (permission.task)", () => {
  it("renders a nested mapping-of-mappings with quoted glob keys", () => {
    const result = toFrontmatter({
      permission: { task: { "*": "deny", triage: "allow" } },
    });
    expect(result).toBe(['permission:', "  task:", '    "*": deny', "    triage: allow"].join("\n"));
  });

  it("quotes a boolean-map key that is a real tool name normally, and a glob key when it is '*'", () => {
    const result = toFrontmatter({ tools: { helpdesk_get_ticket: true, "*": false } });
    expect(result).toBe(["tools:", "  helpdesk_get_ticket: true", '  "*": false'].join("\n"));
  });
});

describe("renderFrontmatterFile", () => {
  it("wraps the frontmatter block in --- delimiters, includes the body, and ends with exactly one trailing LF newline", () => {
    const result = renderFrontmatterFile({ name: "triage" }, "# Triage agent\n\nBody text.");
    expect(result).toBe("---\nname: triage\n---\n# Triage agent\n\nBody text.\n");
    expect(result.endsWith("\n")).toBe(true);
    expect(result.endsWith("\n\n")).toBe(false);
    expect(result.includes("\r")).toBe(false);
  });

  it("normalizes a body that already ends with a newline to exactly one trailing newline", () => {
    const result = renderFrontmatterFile({ name: "triage" }, "Body.\n");
    expect(result).toBe("---\nname: triage\n---\nBody.\n");
  });
});
