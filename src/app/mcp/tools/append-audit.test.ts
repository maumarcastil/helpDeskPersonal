import { describe, expect, it } from "vitest";
import { buildTestHarness } from "./test-helpers.js";

describe("append_audit tool", () => {
  it("only appends: a new entry is added while every prior entry for the ticket stays present and unchanged", async () => {
    const harness = await buildTestHarness();
    try {
      const created = await harness.client.callTool({
        name: "create_ticket",
        arguments: { text: "issue text" },
      });
      const ticketId = (created.structuredContent as { ticket: { id: string } }).ticket.id;
      const before = await harness.auditLog.listByTicket(ticketId as never);
      expect(before.length).toBeGreaterThan(0);

      const result = await harness.client.callTool({
        name: "append_audit",
        arguments: { ticketId, actor: "user", kind: "note", message: "a manual follow-up note" },
      });

      expect(result.isError).toBeFalsy();
      const after = await harness.auditLog.listByTicket(ticketId as never);
      expect(after).toHaveLength(before.length + 1);
      // Every prior entry is still present, unchanged, in the same order.
      expect(after.slice(0, before.length)).toEqual(before);
    } finally {
      await harness.close();
    }
  });

  it("rejects a message longer than 1000 characters", async () => {
    const harness = await buildTestHarness();
    try {
      const created = await harness.client.callTool({
        name: "create_ticket",
        arguments: { text: "issue text" },
      });
      const ticketId = (created.structuredContent as { ticket: { id: string } }).ticket.id;

      const result = await harness.client.callTool({
        name: "append_audit",
        arguments: { ticketId, actor: "user", kind: "note", message: "x".repeat(1001) },
      });

      expect(result.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
