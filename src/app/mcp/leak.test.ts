import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiagnosticReport } from "../../diagnostics/domain/diagnostic-report.js";
import type {
  DiagnosticRequest,
  DiagnosticRunner,
  ProbeTarget,
} from "../../diagnostics/ports/diagnostic-runner.js";
import type { ServiceCatalog } from "../../diagnostics/ports/service-catalog.js";
import type { RunnerOutcome } from "../../diagnostics/domain/runner-outcome.js";
import { POSITIVE_FIXTURES } from "../../redaction/domain/__fixtures__/secrets.js";
import type { Clock } from "../../shared/ports/clock.js";
import type { ImpactedService } from "../../tickets/domain/ticket.js";
import { buildApp } from "../composition-root.js";
import { findPackageRoot, loadConfig } from "../config/load-config.js";
import { createServer } from "./server.js";

const REAL_PACKAGE_ROOT = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

/** A single ever-increasing time source shared by the fake `Clock` and the
 *  fake diagnostic runner's report timestamps, so every timestamp this test
 *  produces (ticket history, remediation `appliedAt`, the diagnostic
 *  re-check's `finishedAt`) is strictly ordered - required by
 *  `canResolve`'s "the re-check must not predate the pending/remediation
 *  anchor" rule (`resolution-rule.ts`). */
class TimeSource {
  private ms: number;
  constructor(startIso: string) {
    this.ms = new Date(startIso).getTime();
  }
  next(): Date {
    const d = new Date(this.ms);
    this.ms += 1000;
    return d;
  }
}

class StubServiceCatalog implements ServiceCatalog {
  resolve(service: ImpactedService): ProbeTarget | null {
    return service === "vpn-gateway" ? { kind: "tcp", host: "vpn.example.com", port: 443 } : null;
  }
  list(): readonly ImpactedService[] {
    return ["vpn-gateway"];
  }
}

class StubDiagnosticRunner implements DiagnosticRunner {
  constructor(private readonly time: TimeSource) {}
  async run(_request: DiagnosticRequest): Promise<RunnerOutcome> {
    const startedAt = this.time.next().toISOString();
    const finishedAt = this.time.next().toISOString();
    const report: DiagnosticReport = {
      schemaVersion: 1,
      probe: "connectivity",
      mode: "mock",
      target: "tcp://vpn.example.com:443",
      status: "reachable",
      checks: [{ name: "tcp", ok: true, latencyMs: 5 }],
      startedAt,
      finishedAt,
    };
    return { kind: "completed", durationMs: 5, report };
  }
}

const VALID_TRIAGED_PAYLOAD = {
  category: "infrastructure-software",
  subcategory: "vpn",
  severity: "medium",
  urgency: "medium",
  affectedUser: "jane.doe",
  impactedService: "vpn-gateway",
};

const secretsByLabel = new Map(POSITIVE_FIXTURES.map((f) => [f.label, f]));
function fixture(label: string) {
  const found = secretsByLabel.get(label);
  if (!found) throw new Error(`unknown fixture label: ${label}`);
  return found;
}

describe("end-to-end redaction leak test (spec sensitive-data-redaction: consistent across all three sinks)", () => {
  let dataDir: string;
  let client: Client;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "helpdesk-leak-test-"));
  });

  afterEach(async () => {
    await client.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("never leaks a fixture secret through any tool response or data/*.json(l) file", async () => {
    const time = new TimeSource("2026-01-01T00:00:00.000Z");
    const fakeClock: Clock = { now: () => time.next() };

    const config = loadConfig(
      { HELPDESK_PSEUDONYM_KEY: "leak-test-key", HELPDESK_DATA_DIR: dataDir },
      { packageRoot: REAL_PACKAGE_ROOT, stderr: { write: () => true } },
    );
    const app = buildApp(config, {
      clock: fakeClock,
      serviceCatalog: new StubServiceCatalog(),
      diagnosticRunner: new StubDiagnosticRunner(time),
    });
    const server = createServer(app);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "leak-test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const password = fixture("password (English)");
    const email = fixture("email address");
    const apiToken = fixture("api key (English)");
    const cardNumber = fixture("card number (valid Luhn)");

    const responses: unknown[] = [];
    const call = async (params: Parameters<Client["callTool"]>[0]) => {
      const result = await client.callTool(params);
      responses.push(result);
      return result;
    };

    const created = await call({
      name: "create_ticket",
      arguments: { text: `My VPN is broken. ${password.text}` },
    });
    const ticketId = (created.structuredContent as { ticket: { id: string } }).ticket.id;

    await call({
      name: "update_ticket",
      arguments: {
        ticketId,
        actor: "triage",
        transition: { to: "Triaged", ...VALID_TRIAGED_PAYLOAD, summary: `VPN issue. ${email.text}` },
      },
    });

    await call({
      name: "update_ticket",
      arguments: {
        ticketId,
        actor: "diagnostic",
        transition: { to: "InProgress", note: `Investigating. ${apiToken.text}` },
      },
    });

    await call({
      name: "append_audit",
      arguments: {
        ticketId,
        actor: "diagnostic",
        kind: "note",
        message: `Found related payment record. ${cardNumber.text}`,
      },
    });

    const diagnosed = await call({
      name: "run_diagnostic",
      arguments: { ticketId, actor: "diagnostic", probe: "connectivity" },
    });
    const firstRunId = (diagnosed.structuredContent as { runId: string }).runId;

    await call({
      name: "apply_remediation",
      arguments: { ticketId, actor: "diagnostic", runId: firstRunId },
    });

    const recheck = await call({
      name: "run_diagnostic",
      arguments: { ticketId, actor: "diagnostic", probe: "connectivity" },
    });
    const recheckRunId = (recheck.structuredContent as { runId: string }).runId;

    const resolved = await call({
      name: "update_ticket",
      arguments: {
        ticketId,
        actor: "user",
        transition: {
          to: "Resolved",
          basis: "user-confirmed",
          diagnosticEvidence: { runId: recheckRunId },
          timestamp: fakeClock.now().toISOString(),
        },
      },
    });
    expect(resolved.isError).toBeFalsy();

    const secretValues = [password.secretValue, email.secretValue, apiToken.secretValue, cardNumber.secretValue];

    const responseText = JSON.stringify(responses);
    for (const secret of secretValues) {
      expect(responseText).not.toContain(secret);
    }

    const ticketsFileContent = readFileSync(join(dataDir, "tickets.json"), "utf8");
    const auditFileContent = readFileSync(join(dataDir, "audit.jsonl"), "utf8");
    for (const secret of secretValues) {
      expect(ticketsFileContent).not.toContain(secret);
      expect(auditFileContent).not.toContain(secret);
    }
  });
});
