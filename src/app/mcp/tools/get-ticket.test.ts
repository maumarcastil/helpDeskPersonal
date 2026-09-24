import { describe, expect, it } from "vitest";
import { buildTestHarness } from "./test-helpers.js";

describe("get_ticket tool", () => {
  it("returns TICKET_NOT_FOUND for a missing ticket", async () => {
    const harness = await buildTestHarness();
    try {
      const result = await harness.client.callTool({
        name: "get_ticket",
        arguments: { ticketId: "tkt_does_not_exist" },
      });
      expect(result.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("returns the redacted ticket plus allowedTransitions for its current state", async () => {
    const harness = await buildTestHarness();
    try {
      const created = await harness.client.callTool({
        name: "create_ticket",
        arguments: { text: "my password is Hunter2024!, help" },
      });
      const ticketId = (created.structuredContent as { ticket: { id: string } }).ticket.id;

      const result = await harness.client.callTool({
        name: "get_ticket",
        arguments: { ticketId },
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        ticket: { id: string; description: string; state: string };
        allowedTransitions: Array<{ to: string; actors: string[] }>;
      };
      expect(structured.ticket.id).toBe(ticketId);
      expect(structured.ticket.description).not.toContain("Hunter2024!");
      // From "New", only "New -> Triaged" (actor: triage) is a valid row.
      expect(structured.allowedTransitions).toEqual([{ to: "Triaged", actors: ["triage"] }]);
    } finally {
      await harness.close();
    }
  });
});
