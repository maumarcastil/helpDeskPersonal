import { describe, expect, it } from "vitest";
import type {
  DiagnosticRequest,
  DiagnosticRunner,
  ProbeTarget,
} from "../../../diagnostics/ports/diagnostic-runner.js";
import type { ServiceCatalog } from "../../../diagnostics/ports/service-catalog.js";
import type { RunnerOutcome } from "../../../diagnostics/domain/runner-outcome.js";
import type { ProbeStatus } from "../../../diagnostics/domain/diagnostic-report.js";
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
  constructor(private readonly status: ProbeStatus) {}
  async run(_request: DiagnosticRequest): Promise<RunnerOutcome> {
    const now = new Date().toISOString();
    return {
      kind: "completed",
      durationMs: 5,
      report: {
        schemaVersion: 1,
        probe: "connectivity",
        mode: "mock",
        target: "tcp://vpn.example.com:443",
        status: this.status,
        checks: [{ name: "tcp", ok: this.status === "reachable", latencyMs: 5 }],
        startedAt: now,
        finishedAt: now,
      },
    };
  }
}

async function createInProgressTicketWithDiagnosticRun(
  harness: Awaited<ReturnType<typeof buildTestHarness>>,
): Promise<{ ticketId: string; runId: string }> {
  const created = await harness.client.callTool({
    name: "create_ticket",
    arguments: { text: "my VPN keeps disconnecting" },
  });
  const ticketId = (created.structuredContent as { ticket: { id: string } }).ticket.id;
  await harness.client.callTool({
    name: "update_ticket",
    arguments: { ticketId, actor: "triage", transition: { to: "Triaged", ...VALID_TRIAGED_PAYLOAD } },
  });
  await harness.client.callTool({
    name: "update_ticket",
    arguments: { ticketId, actor: "diagnostic", transition: { to: "InProgress" } },
  });
  const diagnostic = await harness.client.callTool({
    name: "run_diagnostic",
    arguments: { ticketId, actor: "diagnostic", probe: "connectivity" },
  });
  const runId = (diagnostic.structuredContent as { runId: string }).runId;
  return { ticketId, runId };
}

describe("apply_remediation tool", () => {
  it("applies the allowlisted remediation and transitions to PendingUserConfirmation", async () => {
    const harness = await buildTestHarness({
      serviceCatalog: new StubServiceCatalog(),
      diagnosticRunner: new StubDiagnosticRunner("reachable"),
    });
    try {
      const { ticketId, runId } = await createInProgressTicketWithDiagnosticRun(harness);

      const result = await harness.client.callTool({
        name: "apply_remediation",
        arguments: { ticketId, actor: "diagnostic", runId },
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        ticket: { state: string };
        action: string;
        userMessage: string;
        auditRef: string;
      };
      expect(structured.ticket.state).toBe("PendingUserConfirmation");
      expect(structured.action).toBe("record-service-healthy");
      expect(structured.auditRef).toMatch(/^aud_/);
      expect(structured.userMessage.length).toBeGreaterThan(0);
    } finally {
      await harness.close();
    }
  });

  it("returns NOT_ALLOWLISTED for a run without a remediate decision", async () => {
    const harness = await buildTestHarness({
      serviceCatalog: new StubServiceCatalog(),
      diagnosticRunner: new StubDiagnosticRunner("unreachable"),
    });
    try {
      const { ticketId, runId } = await createInProgressTicketWithDiagnosticRun(harness);

      const result = await harness.client.callTool({
        name: "apply_remediation",
        arguments: { ticketId, actor: "diagnostic", runId },
      });

      expect(result.isError).toBe(true);
      const errorPayload = result.structuredContent as { error: { code: string } };
      expect(errorPayload.error.code).toBe("NOT_ALLOWLISTED");
    } finally {
      await harness.close();
    }
  });

  it("returns DIAGNOSTIC_NOT_USABLE for a stale/missing run reference", async () => {
    const harness = await buildTestHarness({
      serviceCatalog: new StubServiceCatalog(),
      diagnosticRunner: new StubDiagnosticRunner("reachable"),
    });
    try {
      const { ticketId } = await createInProgressTicketWithDiagnosticRun(harness);

      const result = await harness.client.callTool({
        name: "apply_remediation",
        arguments: { ticketId, actor: "diagnostic", runId: "run_does_not_exist" },
      });

      expect(result.isError).toBe(true);
      const errorPayload = result.structuredContent as { error: { code: string } };
      expect(errorPayload.error.code).toBe("DIAGNOSTIC_NOT_USABLE");
    } finally {
      await harness.close();
    }
  });

  it("rejects an actor: 'triage' call server-side", async () => {
    const harness = await buildTestHarness({
      serviceCatalog: new StubServiceCatalog(),
      diagnosticRunner: new StubDiagnosticRunner("reachable"),
    });
    try {
      const { ticketId, runId } = await createInProgressTicketWithDiagnosticRun(harness);

      const result = await harness.client.callTool({
        name: "apply_remediation",
        arguments: { ticketId, actor: "triage", runId },
      });

      expect(result.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
