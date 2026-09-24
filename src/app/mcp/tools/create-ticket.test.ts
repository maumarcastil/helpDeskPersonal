import { describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./test-helpers.js";

describe("create_ticket tool", () => {
  it("creates a ticket for a valid payload and returns its id", async () => {
    const harness: TestHarness = await buildTestHarness();
    try {
      const result = await harness.client.callTool({
        name: "create_ticket",
        arguments: { text: "my VPN is not connecting" },
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { ticket: { id: string; state: string } };
      expect(structured.ticket.state).toBe("New");
      expect(structured.ticket.id).toMatch(/^tkt_/);
    } finally {
      await harness.close();
    }
  });

  it("rejects a payload missing the required text field and creates no ticket", async () => {
    const harness = await buildTestHarness();
    try {
      const result = await harness.client.callTool({
        name: "create_ticket",
        arguments: {} as Record<string, unknown>,
      });

      expect(result.isError).toBe(true);
      expect(await harness.ticketRepository.list({})).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("redacts free-text input before the use case is invoked", async () => {
    const harness = await buildTestHarness();
    try {
      const result = await harness.client.callTool({
        name: "create_ticket",
        arguments: { text: "my password is Hunter2024!" },
      });

      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result.structuredContent)).not.toContain("Hunter2024!");
      const [stored] = await harness.ticketRepository.list({});
      expect(stored?.description).not.toContain("Hunter2024!");
    } finally {
      await harness.close();
    }
  });
});
