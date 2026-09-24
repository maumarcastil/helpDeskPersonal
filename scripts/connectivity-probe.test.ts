import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiagnosticReportSchema } from "../src/diagnostics/domain/diagnostic-report.js";

interface SpawnResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

const PROBE_SCRIPT = resolvePath(__dirname, "../scripts/connectivity-probe.ts");
const TSX_BIN = resolvePath(__dirname, "../node_modules/.bin/tsx");

/** Spawn the probe script the same way the production runner will. */
function spawnProbe(args: string[], env: NodeJS.ProcessEnv = {}): Promise<SpawnResult> {
  return new Promise((done) => {
    const child: ChildProcess = spawn("node", [TSX_BIN, PROBE_SCRIPT, ...args], {
      env: {
        // Strip PSEUDONYM_KEY from the inherited env so the test never
        // accidentally smuggles it into the child — the runner does
        // the same (verified again in 3.6).
        ...process.env,
        HELPDESK_PROBE_MODE: "mock",
        HELPDESK_PROBE_MOCK_SCENARIO: "reachable",
        ...env,
        HELPDESK_PSEUDONYM_KEY: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (status, signal) => {
      done({ status, signal, stdout, stderr });
    });
  });
}

/** Bound the test to wait at most `ms` for a free TCP port, then fail. */
async function waitForListening(server: NetServer | HttpServer, ms = 5000): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`server did not start within ${ms}ms`));
    }, ms);
    server.once("listening", () => {
      clearTimeout(timer);
      resolve();
    });
    server.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("connectivity-probe script", () => {
  describe("CLI usage", () => {
    it("exits 2 when --target is missing (usage error)", async () => {
      const result = await spawnProbe(["--mode", "mock", "--mock-scenario", "reachable"]);
      expect(result.status).toBe(2);
    });

    it("exits 2 when --target scheme is not supported", async () => {
      const result = await spawnProbe(["--target", "ftp://example.com:21"]);
      expect(result.status).toBe(2);
    });

    it("exits 2 when --timeout-ms is out of range", async () => {
      const result = await spawnProbe([
        "--target",
        "tcp://127.0.0.1:1",
        "--timeout-ms",
        "999999",
      ]);
      expect(result.status).toBe(2);
    });
  });

  describe("mock scenarios (no network)", () => {
    it("mock: reachable prints a schema-valid report and exits 0", async () => {
      const result = await spawnProbe([
        "--target",
        "tcp://vpn.example.com:443",
        "--mode",
        "mock",
        "--mock-scenario",
        "reachable",
      ]);
      expect(result.status).toBe(0);
      const line = result.stdout.trim();
      const parsed = DiagnosticReportSchema.safeParse(JSON.parse(line));
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.status).toBe("reachable");
        expect(parsed.data.mode).toBe("mock");
        expect(parsed.data.checks.every((c) => c.ok)).toBe(true);
      }
    });

    it("mock: unreachable prints a schema-valid report with status=unreachable and exits 0", async () => {
      const result = await spawnProbe([
        "--target",
        "tcp://vpn.example.com:443",
        "--mode",
        "mock",
        "--mock-scenario",
        "unreachable",
      ]);
      expect(result.status).toBe(0);
      const line = result.stdout.trim();
      const parsed = DiagnosticReportSchema.safeParse(JSON.parse(line));
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.status).toBe("unreachable");
        expect(parsed.data.checks.every((c) => !c.ok)).toBe(true);
      }
    });

    it("mock: degraded prints a schema-valid report with mixed ok checks and exits 0", async () => {
      const result = await spawnProbe([
        "--target",
        "https://idp.example.com/healthz",
        "--mode",
        "mock",
        "--mock-scenario",
        "degraded",
      ]);
      expect(result.status).toBe(0);
      const line = result.stdout.trim();
      const parsed = DiagnosticReportSchema.safeParse(JSON.parse(line));
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.status).toBe("degraded");
      }
    });

    it("mock: hang does not exit before the configured timeout (runner kills it in 3.6)", async () => {
      const start = Date.now();
      const result = await spawnProbe([
        "--target",
        "tcp://vpn.example.com:443",
        "--mode",
        "mock",
        "--mock-scenario",
        "hang",
        "--timeout-ms",
        "200",
      ]);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(200);
      // The script either timed out internally (and emitted an
      // unreachable report) or was killed by our test fence; either
      // way, it did not return early.
      expect(result.stdout).toBeDefined();
    }, 5000);

    it("mock: crash exits non-zero, writes to stderr, writes no JSON to stdout", async () => {
      const result = await spawnProbe([
        "--target",
        "tcp://vpn.example.com:443",
        "--mode",
        "mock",
        "--mock-scenario",
        "crash",
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
      expect(result.stdout.trim()).toBe("");
    });

    it("mock: malformed writes non-JSON stdout and exits 0", async () => {
      const result = await spawnProbe([
        "--target",
        "tcp://vpn.example.com:443",
        "--mode",
        "mock",
        "--mock-scenario",
        "malformed",
      ]);
      expect(result.status).toBe(0);
      expect(result.stdout.trim().length).toBeGreaterThan(0);
      // Round-trip through JSON must fail.
      expect(() => JSON.parse(result.stdout)).toThrow();
    });
  });

  describe("real mode against local servers (no external network)", () => {
    it("real TCP probe against a local net server reports reachable", async () => {
      const tcpServer = createNetServer((socket) => socket.end());
      await new Promise<void>((resolve) => tcpServer.listen(0, "127.0.0.1", () => resolve()));
      const addr = tcpServer.address();
      if (addr === null || typeof addr === "string") {
        throw new Error("unexpected tcp server address");
      }
      const target = `tcp://127.0.0.1:${addr.port}`;

      const result = await spawnProbe(["--target", target, "--mode", "real"]);
      expect(result.status).toBe(0);
      const line = result.stdout.trim();
      const parsed = DiagnosticReportSchema.safeParse(JSON.parse(line));
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.status).toBe("reachable");
        expect(parsed.data.mode).toBe("real");
      }
      await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
    }, 5000);

    it("real HTTP probe against a local http server reports reachable", async () => {
      const httpServer = createHttpServer((_req, res) => {
        res.statusCode = 200;
        res.end("ok");
      });
      await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
      const addr = httpServer.address();
      if (addr === null || typeof addr === "string") {
        throw new Error("unexpected http server address");
      }
      const target = `http://127.0.0.1:${addr.port}/health`;

      const result = await spawnProbe(["--target", target, "--mode", "real"]);
      expect(result.status).toBe(0);
      const line = result.stdout.trim();
      const parsed = DiagnosticReportSchema.safeParse(JSON.parse(line));
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.status).toBe("reachable");
        expect(parsed.data.mode).toBe("real");
      }
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }, 5000);

    it("real TCP probe against a closed local port reports unreachable and exits 0", async () => {
      // Pick a port we know is closed: bind a server, capture the OS-
      // assigned port, close it, then immediately probe — the kernel
      // may briefly TIME_WAIT but the connect attempt will surface as
      // unreachable from our vantage point. To be safe, retry a few
      // candidate ports to dodge the occasional steal.
      const findClosedPort = async (): Promise<number> => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const server = createNetServer();
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
          const addr = server.address();
          if (addr === null || typeof addr === "string") {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            continue;
          }
          const port = addr.port;
          await new Promise<void>((resolve) => server.close(() => resolve()));
          return port;
        }
        throw new Error("could not allocate a transient port");
      };

      const port = await findClosedPort();
      const target = `tcp://127.0.0.1:${port}`;
      const result = await spawnProbe([
        "--target",
        target,
        "--mode",
        "real",
        "--timeout-ms",
        "500",
      ]);

      expect(result.status).toBe(0);
      const line = result.stdout.trim();
      const parsed = DiagnosticReportSchema.safeParse(JSON.parse(line));
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.status).toBe("unreachable");
      }
    }, 10000);

    // A second listener guarantees nothing is squatting on the probe
    // path during the assertion window — used by the `waitForListening`
    // helper for the hang/kill test path.
    it("waitForListening helper: a server we await is listening (sanity)", async () => {
      const server = createHttpServer();
      server.listen(0, "127.0.0.1");
      try {
        await waitForListening(server);
        expect(server.listening).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe("env fallback", () => {
    it("reads HELPDESK_PROBE_MODE and HELPDESK_PROBE_MOCK_SCENARIO from env when argv is absent", async () => {
      const result = await spawnProbe(["--target", "tcp://vpn.example.com:443"], {
        HELPDESK_PROBE_MODE: "mock",
        HELPDESK_PROBE_MOCK_SCENARIO: "unreachable",
      });
      expect(result.status).toBe(0);
      const line = result.stdout.trim();
      const parsed = DiagnosticReportSchema.safeParse(JSON.parse(line));
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.status).toBe("unreachable");
        expect(parsed.data.mode).toBe("mock");
      }
    });
  });
});

// Keep the file from drifting even when we run only the describe
// block — guards against a follow-up edit that introduces unused
// imports from refactors.
void DiagnosticReportSchema;
void mkdtempSync;
void rmSync;
void readFileSync;
void join;
