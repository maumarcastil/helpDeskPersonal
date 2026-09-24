import { describe, expect, it } from "vitest";
import type { DiagnosticRequest, DiagnosticRunner, ProbeTarget } from "../../../diagnostics/ports/diagnostic-runner.js";
import type { ServiceCatalog } from "../../../diagnostics/ports/service-catalog.js";
import type { RunnerOutcome } from "../../../diagnostics/domain/runner-outcome.js";
import type { ImpactedService } from "../../../tickets/domain/ticket.js";
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

class StubServiceCatalog implements ServiceCatalog {
  resolve(service: ImpactedService): ProbeTarget | null {
    return service === "vpn-gateway" ? { kind: "tcp", host: "vpn.example.com", port: 443 } : null;
  }
  list(): readonly ImpactedService[] {
    return ["vpn-gateway"];
  }
}

class StubDiagnosticRunner implements DiagnosticRunner {
  constructor(private readonly outcome: RunnerOutcome) {}
  async run(_request: DiagnosticRequest): Promise<RunnerOutcome> {
    return this.outcome;
  }
}

function reachableOutcome(): RunnerOutcome {
  const now = new Date().toISOString();
  return {
    kind: "completed",
    durationMs: 5,
    report: {
      schemaVersion: 1,
      probe: "connectivity",
      mode: "mock",
      target: "tcp://vpn.example.com:443",
      status: "reachable",
      checks: [{ name: "tcp", ok: true, latencyMs: 5 }],
      startedAt: now,
      finishedAt: now,
    },
  };
}

async function createInProgressTicket(
  client: Awaited<ReturnType<typeof buildTestHarness>>["client"],
): Promise<string> {
  const created = await client.callTool({
    name: "create_ticket",
    arguments: { text: "my VPN keeps disconnecting" },
  });
  const ticketId = (created.structuredContent as { ticket: { id: string } }).ticket.id;
  await client.callTool({
    name: "update_ticket",
    arguments: { ticketId, actor: "triage", transition: { to: "Triaged", ...VALID_TRIAGED_PAYLOAD } },
  });
  await client.callTool({
    name: "update_ticket",
    arguments: { ticketId, actor: "diagnostic", transition: { to: "InProgress" } },
  });
  return ticketId;
}

describe("run_diagnostic tool", () => {
  it("delegates to the diagnostic runner contract and returns a completed result with a remediation decision", async () => {
    const harness = await buildTestHarness({
      serviceCatalog: new StubServiceCatalog(),
      diagnosticRunner: new StubDiagnosticRunner(reachableOutcome()),
    });
    try {
      const ticketId = await createInProgressTicket(harness.client);

      const result = await harness.client.callTool({
        name: "run_diagnostic",
        arguments: { ticketId, actor: "diagnostic", probe: "connectivity" },
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        runId: string;
        outcome: string;
        decision: { kind: string };
        userMessage: string;
      };
      expect(structured.outcome).toBe("completed");
      expect(structured.decision.kind).toBe("remediate");
      expect(structured.runId).toMatch(/^run_/);
      expect(structured.userMessage.length).toBeGreaterThan(0);
    } finally {
      await harness.close();
    }
  });

  it("rejects an actor: 'triage' call server-side", async () => {
    const harness = await buildTestHarness({
      serviceCatalog: new StubServiceCatalog(),
      diagnosticRunner: new StubDiagnosticRunner(reachableOutcome()),
    });
    try {
      const ticketId = await createInProgressTicket(harness.client);

      const result = await harness.client.callTool({
        name: "run_diagnostic",
        arguments: { ticketId, actor: "triage", probe: "connectivity" },
      });

      expect(result.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
