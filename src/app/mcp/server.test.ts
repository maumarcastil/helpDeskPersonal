import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "./tool-names.js";
import { buildTestHarness } from "./tools/test-helpers.js";

describe("createServer", () => {
  it("advertises exactly TOOL_NAMES, no more, no fewer (spec helpdesk-mcp-server: MCP Tool Surface)", async () => {
    const harness = await buildTestHarness();
    try {
      const { tools } = await harness.client.listTools();
      const advertisedNames = tools.map((tool) => tool.name).sort();
      expect(advertisedNames).toEqual([...TOOL_NAMES].sort());
    } finally {
      await harness.close();
    }
  });
});
