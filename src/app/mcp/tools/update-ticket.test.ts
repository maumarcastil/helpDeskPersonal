import { describe, expect, it } from "vitest";
import { buildTestHarness } from "./test-helpers.js";

const VALID_TRIAGED_PAYLOAD = {
  category: "infrastructure-software",
  subcategory: "vpn",
  severity: "medium",
  urgency: "medium",
  affectedUser: "jane.doe",
  impactedService: "vpn-gateway",
  summary: "VPN client cannot connect to the corporate gateway",
};

async function createTicket(client: Awaited<ReturnType<typeof buildTestHarness>>["client"]) {
  const created = await client.callTool({
    name: "create_ticket",
    arguments: { text: "my VPN keeps disconnecting" },
  });
  return (created.structuredContent as { ticket: { id: string } }).ticket.id;
}

describe("update_ticket tool", () => {
  it("applies a valid transition and returns the updated ticket", async () => {
    const harness = await buildTestHarness();
    try {
      const ticketId = await createTicket(harness.client);

      const result = await harness.client.callTool({
        name: "update_ticket",
        arguments: {
          ticketId,
          actor: "triage",
          transition: { to: "Triaged", ...VALID_TRIAGED_PAYLOAD },
        },
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        ticket: { state: string };
        auditRef: string;
      };
      expect(structured.ticket.state).toBe("Triaged");
      expect(structured.auditRef).toMatch(/^aud_/);
    } finally {
      await harness.close();
    }
  });

  it("rejects an invalid transition with a clear error and leaves the ticket unchanged", async () => {
    const harness = await buildTestHarness();
    try {
      const ticketId = await createTicket(harness.client);

      const result = await harness.client.callTool({
        name: "update_ticket",
        arguments: {
          ticketId,
          actor: "user",
          transition: { to: "Closed", resolutionSummary: "n/a", confirmationSource: "user" },
        },
      });

      expect(result.isError).toBe(true);
      const errorPayload = result.structuredContent as { error: { code: string } };
      expect(errorPayload.error.code).toBe("INVALID_TRANSITION");

      const fetched = await harness.client.callTool({
        name: "get_ticket",
        arguments: { ticketId },
      });
      const fetchedState = (fetched.structuredContent as { ticket: { state: string } }).ticket.state;
      expect(fetchedState).toBe("New");
    } finally {
      await harness.close();
    }
  });

  it("the same invalid call is rejected identically regardless of an unrelated request id", async () => {
    const harness = await buildTestHarness();
    try {
      const ticketId = await createTicket(harness.client);
      const invalidCall = {
        name: "update_ticket" as const,
        arguments: {
          ticketId,
          actor: "user",
          transition: { to: "Closed", resolutionSummary: "n/a", confirmationSource: "user" },
        },
      };

      // Two independent calls with identical arguments naturally carry
      // different JSON-RPC request ids under the hood (the SDK's Client
      // assigns them); the point of this test is that nothing about the
      // server's response depends on that id, since the server has no
      // platform/session awareness at all.
      const first = await harness.client.callTool(invalidCall);
      const second = await harness.client.callTool(invalidCall);

      expect(first.structuredContent).toEqual(second.structuredContent);
    } finally {
      await harness.close();
    }
  });

  it("rejects a wrong actor for an otherwise-valid transition with ACTOR_NOT_PERMITTED", async () => {
    const harness = await buildTestHarness();
    try {
      const ticketId = await createTicket(harness.client);

      const result = await harness.client.callTool({
        name: "update_ticket",
        arguments: {
          ticketId,
          actor: "diagnostic",
          transition: { to: "Triaged", ...VALID_TRIAGED_PAYLOAD },
        },
      });

      expect(result.isError).toBe(true);
      const errorPayload = result.structuredContent as { error: { code: string } };
      expect(errorPayload.error.code).toBe("ACTOR_NOT_PERMITTED");
    } finally {
      await harness.close();
    }
  });

  it("rejects a Triaged transition that supplies a client-side priority field (override #2, MCP boundary)", async () => {
    const harness = await buildTestHarness();
    try {
      const ticketId = await createTicket(harness.client);

      const result = await harness.client.callTool({
        name: "update_ticket",
        arguments: {
          ticketId,
          actor: "triage",
          transition: { to: "Triaged", ...VALID_TRIAGED_PAYLOAD, priority: "P1" },
        },
      });

      expect(result.isError).toBe(true);
      const errorPayload = result.structuredContent as { error: { code: string } };
      expect(errorPayload.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await harness.close();
    }
  });
});
