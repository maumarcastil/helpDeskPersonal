import { describe, expect, it } from "vitest";
import { TOOL_NAMES, type ToolName } from "../../src/app/mcp/tool-names.js";
import { CAPABILITIES, type Capability } from "./definitions/schema.js";
import { CAPABILITY_TOOL_MAP, toolsForCapabilities, toolsForCapability } from "./capabilities.js";

describe("CAPABILITY_TOOL_MAP", () => {
  it("has one entry per declared capability", () => {
    expect(Object.keys(CAPABILITY_TOOL_MAP).sort()).toEqual([...CAPABILITIES].sort());
  });

  it("maps every mapped tool name to a real entry in TOOL_NAMES", () => {
    for (const capability of CAPABILITIES) {
      for (const tool of CAPABILITY_TOOL_MAP[capability]) {
        expect(TOOL_NAMES, `capability "${capability}" maps to unknown tool "${tool}"`).toContain(tool);
      }
    }
  });

  it("covers every TOOL_NAMES entry with exactly one capability", () => {
    for (const tool of TOOL_NAMES) {
      const owners = CAPABILITIES.filter((capability: Capability) =>
        (CAPABILITY_TOOL_MAP[capability] as readonly ToolName[]).includes(tool),
      );
      expect(owners, `tool "${tool}" must be covered by exactly one capability`).toHaveLength(1);
    }
  });

  it("maps the exact capability -> tool table from the feature document", () => {
    expect(CAPABILITY_TOOL_MAP).toEqual({
      "ticket.create": ["create_ticket"],
      "ticket.read": ["get_ticket", "list_tickets"],
      "ticket.update": ["update_ticket"],
      "audit.append": ["append_audit"],
      "diagnostic.run": ["run_diagnostic"],
      "remediation.apply": ["apply_remediation"],
    });
  });
});

describe("toolsForCapability", () => {
  it("returns the tools for one capability", () => {
    expect(toolsForCapability("ticket.read")).toEqual(["get_ticket", "list_tickets"]);
  });
});

describe("toolsForCapabilities", () => {
  it("returns the deduplicated union of tools for several capabilities", () => {
    expect([...toolsForCapabilities(["ticket.read", "ticket.update", "ticket.read"])].sort()).toEqual(
      ["get_ticket", "list_tickets", "update_ticket"].sort(),
    );
  });

  it("returns an empty array for no capabilities", () => {
    expect(toolsForCapabilities([])).toEqual([]);
  });
});
