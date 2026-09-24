import { describe, expect, it } from "vitest";
import { buildTestHarness } from "./test-helpers.js";

describe("list_tickets tool", () => {
  it("lists created tickets and clamps limit to 50", async () => {
    const harness = await buildTestHarness();
    try {
      await harness.client.callTool({ name: "create_ticket", arguments: { text: "issue one" } });
      await harness.client.callTool({ name: "create_ticket", arguments: { text: "issue two" } });

      const result = await harness.client.callTool({
        name: "list_tickets",
        arguments: { limit: 500 },
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { tickets: Array<{ id: string }> };
      expect(structured.tickets).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  it("respects the state filter", async () => {
    const harness = await buildTestHarness();
    try {
      await harness.client.callTool({ name: "create_ticket", arguments: { text: "issue one" } });

      const result = await harness.client.callTool({
        name: "list_tickets",
        arguments: { state: "Triaged" },
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { tickets: Array<{ id: string }> };
      expect(structured.tickets).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});
