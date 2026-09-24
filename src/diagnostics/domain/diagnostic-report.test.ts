import { describe, expect, it } from "vitest";
import { DiagnosticReportSchema } from "./diagnostic-report.js";

function validReport(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    probe: "connectivity",
    mode: "mock",
    target: "tcp://vpn.internal.example.com:443",
    status: "reachable",
    checks: [{ name: "tcp", ok: true, latencyMs: 12 }],
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

describe("DiagnosticReportSchema", () => {
  it("accepts a valid schemaVersion 1 report with 1 check", () => {
    const result = DiagnosticReportSchema.safeParse(validReport());
    expect(result.success).toBe(true);
  });

  it("accepts a valid report with 5 checks (the max)", () => {
    const checks = Array.from({ length: 5 }, (_, i) => ({
      name: "dns",
      ok: true,
      latencyMs: i,
    }));
    const result = DiagnosticReportSchema.safeParse(validReport({ checks }));
    expect(result.success).toBe(true);
  });

  it("rejects a report with 0 checks", () => {
    const result = DiagnosticReportSchema.safeParse(validReport({ checks: [] }));
    expect(result.success).toBe(false);
  });

  it("rejects a report with more than 5 checks", () => {
    const checks = Array.from({ length: 6 }, (_, i) => ({
      name: "dns",
      ok: true,
      latencyMs: i,
    }));
    const result = DiagnosticReportSchema.safeParse(validReport({ checks }));
    expect(result.success).toBe(false);
  });

  it("rejects an unknown schemaVersion", () => {
    const result = DiagnosticReportSchema.safeParse(validReport({ schemaVersion: 2 }));
    expect(result.success).toBe(false);
  });

  it("rejects a check name outside dns|tcp|http", () => {
    const result = DiagnosticReportSchema.safeParse(
      validReport({ checks: [{ name: "ping", ok: true, latencyMs: 1 }] }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a status outside reachable|degraded|unreachable", () => {
    const result = DiagnosticReportSchema.safeParse(validReport({ status: "unknown" }));
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognized extra field (.strict())", () => {
    const result = DiagnosticReportSchema.safeParse(validReport({ extra: "nope" }));
    expect(result.success).toBe(false);
  });
});
