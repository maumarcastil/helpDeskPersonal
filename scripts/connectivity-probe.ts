#!/usr/bin/env node
/**
 * Connectivity probe script (ADR 0007). Spawned as a child process by
 * `ChildProcessDiagnosticRunner` so a hung or compromised probe can be
 * killed and classified (timeout / nonzero exit / malformed / oversize)
 * without taking the MCP server down.
 *
 * Contract (one full report, exactly one stdout line, ≤ 64 KiB):
 *   stdout = JSON.stringify(DiagnosticReportSchema) + "\n"
 * Exit codes:
 *   0 = the probe ran and the verdict is in the payload (an unreachable
 *       target is exit 0 — "ran successfully, service is down" is not
 *       a runner failure);
 *   2 = usage error (missing target, bad scheme, bad timeout);
 *   3 = internal error;
 *   anything else = crash.
 *
 * Defaults: `--mode mock` and `--mock-scenario reachable` (per the user
 * override of the original "real by default" decision, captured in
 * `.env.example`). Real mode never reaches the network when the env
 * vars override it; the mock scenarios are pure CPU/clock.
 */

import { lookup } from "node:dns/promises";
import { connect as netConnect } from "node:net";
import process from "node:process";
import { argv as processArgv, env as processEnv } from "node:process";
import { z } from "zod";
import { DiagnosticReportSchema } from "../src/diagnostics/domain/diagnostic-report.js";

type CheckName = "dns" | "tcp" | "http";
type ProbeStatus = "reachable" | "degraded" | "unreachable";
type Mode = "real" | "mock";
type MockScenario =
  | "reachable"
  | "unreachable"
  | "degraded"
  | "hang"
  | "crash"
  | "malformed";

interface CheckRecord {
  name: CheckName;
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

const DEGRADED_LATENCY_MS = 1500;
const SLOW_HOST_MS = 1700;
const HANG_BUFFER_MS = 50;
const MAX_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const DEFAULT_TIMEOUT_MS = 3000;

interface ParsedArgs {
  readonly target: string | undefined;
  readonly timeoutMs: number;
  readonly mode: Mode;
  readonly mockScenario: MockScenario;
}

function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): ParsedArgs | string {
  let target: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let mode: Mode | undefined;
  let mockScenario: MockScenario | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--target") {
      target = argv[++i];
    } else if (arg === "--timeout-ms") {
      const raw = argv[++i];
      if (raw === undefined) return "--timeout-ms requires a value";
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return "--timeout-ms must be a finite number";
      if (parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
        return `--timeout-ms must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`;
      }
      timeoutMs = Math.floor(parsed);
    } else if (arg === "--mode") {
      const raw = argv[++i];
      if (raw === "real" || raw === "mock") {
        mode = raw;
      } else {
        return "--mode must be 'real' or 'mock'";
      }
    } else if (arg === "--mock-scenario") {
      const raw = argv[++i];
      const allowed: MockScenario[] = [
        "reachable",
        "unreachable",
        "degraded",
        "hang",
        "crash",
        "malformed",
      ];
      if (raw && (allowed as string[]).includes(raw)) {
        mockScenario = raw as MockScenario;
      } else {
        return "--mock-scenario must be one of: " + allowed.join(", ");
      }
    } else if (arg === "--help" || arg === "-h") {
      return "help";
    }
  }

  if (mode === undefined) {
    const envMode = env["HELPDESK_PROBE_MODE"];
    if (envMode === "real" || envMode === "mock") {
      mode = envMode;
    } else {
      mode = "mock";
    }
  }
  if (mockScenario === undefined) {
    const envScenario = env["HELPDESK_PROBE_MOCK_SCENARIO"];
    const allowed: MockScenario[] = [
      "reachable",
      "unreachable",
      "degraded",
      "hang",
      "crash",
      "malformed",
    ];
    if (envScenario && (allowed as string[]).includes(envScenario)) {
      mockScenario = envScenario as MockScenario;
    } else {
      mockScenario = "reachable";
    }
  }

  return { target, timeoutMs, mode, mockScenario };
}

function parseTarget(raw: string): { scheme: "tcp" | "http" | "https"; rest: string } | null {
  const tcpMatch = /^tcp:\/\/(.+)$/i.exec(raw);
  if (tcpMatch) {
    return { scheme: "tcp", rest: tcpMatch[1] ?? "" };
  }
  const httpMatch = /^http:\/\/(.+)$/i.exec(raw);
  if (httpMatch) {
    return { scheme: "http", rest: httpMatch[1] ?? "" };
  }
  const httpsMatch = /^https:\/\/(.+)$/i.exec(raw);
  if (httpsMatch) {
    return { scheme: "https", rest: httpsMatch[1] ?? "" };
  }
  return null;
}

function parseTcpRest(rest: string): { host: string; port: number } | null {
  const lastColon = rest.lastIndexOf(":");
  if (lastColon < 0) return null;
  const host = rest.slice(0, lastColon);
  const portStr = rest.slice(lastColon + 1);
  const port = Number(portStr);
  if (host.length === 0) return null;
  if (!Number.isFinite(port) || port < 1 || port > 65535 || !Number.isInteger(port)) {
    return null;
  }
  return { host, port };
}

function parseHttpRest(rest: string): { scheme: "http" | "https"; host: string; port: number; path: string } | null {
  // rest may be "host", "host:port", "host/path", or "host:port/path".
  const slashIndex = rest.indexOf("/");
  const authority = slashIndex < 0 ? rest : rest.slice(0, slashIndex);
  const path = slashIndex < 0 ? "" : rest.slice(slashIndex);
  const parsed = parseTcpRest(authority);
  if (parsed === null) return null;
  if (!path.startsWith("/")) return null;
  return {
    scheme: "http",
    host: parsed.host,
    port: parsed.port,
    path,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

async function mockReport(
  target: string,
  timeoutMs: number,
  scenario: MockScenario,
): Promise<{ status: number; body?: string }> {
  if (scenario === "hang") {
    await new Promise((resolve) => setTimeout(resolve, timeoutMs + HANG_BUFFER_MS));
    // Returning exit 0 here is wrong by design — the parent runner is
    // the one that should kill us. We just stall until then.
    return { status: 1 };
  }
  if (scenario === "crash") {
    process.stderr.write("connectivity-probe: mock crash scenario\n");
    return { status: 1 };
  }
  if (scenario === "malformed") {
    process.stdout.write("not-json-at-all-just-garbage\n");
    return { status: 0 };
  }

  const startedAt = nowIso();
  const checks: CheckRecord[] = [];
  let status: ProbeStatus;

  if (scenario === "reachable") {
    checks.push({ name: "dns", ok: true, latencyMs: 5 });
    checks.push({ name: "tcp", ok: true, latencyMs: 20 });
    status = "reachable";
  } else if (scenario === "unreachable") {
    checks.push({ name: "dns", ok: false, latencyMs: 200, detail: "ENOTFOUND" });
    checks.push({ name: "tcp", ok: false, latencyMs: 0, detail: "no route" });
    status = "unreachable";
  } else {
    // degraded: one ok, one slow
    checks.push({ name: "dns", ok: true, latencyMs: 5 });
    checks.push({ name: "tcp", ok: true, latencyMs: SLOW_HOST_MS });
    status = "degraded";
  }

  const report = {
    schemaVersion: 1 as const,
    probe: "connectivity" as const,
    mode: "mock" as const,
    target,
    status,
    checks,
    startedAt,
    finishedAt: nowIso(),
  };
  return { status: 0, body: JSON.stringify(DiagnosticReportSchema.parse(report)) };
}

async function realProbe(
  rawTarget: string,
  timeoutMs: number,
): Promise<{ status: number; body?: string }> {
  const parsed = parseTarget(rawTarget);
  if (parsed === null) return { status: 2 };

  const startedAt = nowIso();
  const checks: CheckRecord[] = [];
  let status: ProbeStatus = "reachable";

  if (parsed.scheme === "tcp") {
    const tcp = parseTcpRest(parsed.rest);
    if (tcp === null) return { status: 2 };
    const dnsStart = Date.now();
    let dnsOk = true;
    let dnsDetail: string | undefined;
    try {
      await lookup(tcp.host);
    } catch (err) {
      dnsOk = false;
      dnsDetail = (err as NodeJS.ErrnoException).code ?? "ENOTFOUND";
    }
    checks.push({ name: "dns", ok: dnsOk, latencyMs: Date.now() - dnsStart, ...(dnsDetail ? { detail: dnsDetail } : {}) });

    if (dnsOk) {
      const tcpStart = Date.now();
      const tcpOk = await new Promise<boolean>((resolve) => {
        let done = false;
        const socket = netConnect({ host: tcp.host, port: tcp.port });
        const finish = (ok: boolean): void => {
          if (done) return;
          done = true;
          socket.destroy();
          resolve(ok);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        socket.once("connect", () => {
          clearTimeout(timer);
          finish(true);
        });
        socket.once("error", () => {
          clearTimeout(timer);
          finish(false);
        });
      });
      const latency = Date.now() - tcpStart;
      checks.push({ name: "tcp", ok: tcpOk, latencyMs: latency });
      if (!tcpOk) status = "unreachable";
    } else {
      checks.push({ name: "tcp", ok: false, latencyMs: 0, detail: "skipped: dns failed" });
      status = "unreachable";
    }
  } else {
    const httpParsed = parseHttpRest(parsed.rest);
    if (httpParsed === null) return { status: 2 };
    const url = `${parsed.scheme}://${httpParsed.host}:${httpParsed.port}${httpParsed.path}`;
    const dnsStart = Date.now();
    let dnsOk = true;
    let dnsDetail: string | undefined;
    try {
      await lookup(httpParsed.host);
    } catch (err) {
      dnsOk = false;
      dnsDetail = (err as NodeJS.ErrnoException).code ?? "ENOTFOUND";
    }
    checks.push({ name: "dns", ok: dnsOk, latencyMs: Date.now() - dnsStart, ...(dnsDetail ? { detail: dnsDetail } : {}) });

    const httpStart = Date.now();
    let httpOk = false;
    let statusCode: number | undefined;
    let httpDetail: string | undefined;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      statusCode = response.status;
      httpOk = response.status < 500;
      if (!httpOk) httpDetail = `status ${response.status}`;
    } catch (err) {
      httpOk = false;
      httpDetail = (err as Error).name === "TimeoutError" ? "timeout" : "fetch failed";
    }
    const latency = Date.now() - httpStart;
    checks.push({ name: "http", ok: httpOk, latencyMs: latency, ...(statusCode !== undefined ? { detail: `status ${statusCode}` } : (httpDetail ? { detail: httpDetail } : {})) });

    if (!httpOk) {
      status = "unreachable";
    } else if (latency > DEGRADED_LATENCY_MS) {
      status = "degraded";
    }
  }

  const report = {
    schemaVersion: 1 as const,
    probe: "connectivity" as const,
    mode: "real" as const,
    target: rawTarget,
    status,
    checks,
    startedAt,
    finishedAt: nowIso(),
  };
  return { status: 0, body: JSON.stringify(DiagnosticReportSchema.parse(report)) };
}

async function main(): Promise<number> {
  const parsed = parseArgs(processArgv.slice(2), processEnv);
  if (typeof parsed === "string") {
    if (parsed === "help") {
      process.stderr.write(
        "Usage: connectivity-probe --target <tcp|http|https://host[:port][/path]> [--timeout-ms N] [--mode real|mock] [--mock-scenario ...]\n",
      );
      return 2;
    }
    process.stderr.write(`usage: ${parsed}\n`);
    return 2;
  }
  if (parsed.target === undefined || parsed.target.length === 0) {
    process.stderr.write("usage: --target is required\n");
    return 2;
  }
  if (parseTarget(parsed.target) === null) {
    process.stderr.write("usage: --target scheme must be tcp, http, or https\n");
    return 2;
  }

  try {
    const result =
      parsed.mode === "mock"
        ? await mockReport(parsed.target, parsed.timeoutMs, parsed.mockScenario)
        : await realProbe(parsed.target, parsed.timeoutMs);

    if (result.body !== undefined) {
      process.stdout.write(`${result.body}\n`);
    }
    return result.status;
  } catch (err) {
    process.stderr.write(
      `internal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 3;
  }
}

// Top-level await is fine on modern Node; we use a single-shot promise
// then call process.exit with its resolved code so any leaked timer /
// handle from the mock scenarios cannot keep the event loop alive.
main().then(
  (code) => {
    process.exit(code);
  },
  (err) => {
    process.stderr.write(
      `internal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(3);
  },
);

// Touch the zod namespace so the keep-build happy path (no schema
// imported by name elsewhere) still has the reference — defensive
// only.
void z;
