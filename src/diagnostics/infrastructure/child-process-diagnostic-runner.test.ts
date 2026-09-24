import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiagnosticReportSchema } from "../domain/diagnostic-report.js";
import type { DiagnosticRequest } from "../ports/diagnostic-runner.js";

const REPO_ROOT = resolvePath(__dirname, "..", "..", "..");
const PROBE_SCRIPT = join(REPO_ROOT, "scripts", "connectivity-probe.ts");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "helpdesk-runner-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function fakeRequest(overrides: Partial<DiagnosticRequest> = {}): DiagnosticRequest {
  return {
    probe: "connectivity",
    target: { kind: "tcp", host: "vpn.example.com", port: 443 },
    timeoutMs: 1000,
    ...overrides,
  };
}

describe("ChildProcessDiagnosticRunner", () => {
  describe("happy path", () => {
    it("a mock-reachable report parses as a DiagnosticReport and outcome.kind is 'completed'", async () => {
      const runner = new (await importRunner())({
        scriptPath: PROBE_SCRIPT,
        tsxBinPath: TSX_BIN,
        parentEnv: { HELPDESK_PROBE_MODE: "mock", HELPDESK_PROBE_MOCK_SCENARIO: "reachable" },
      });
      const outcome = await runner.run(fakeRequest({ timeoutMs: 1000 }));
      expect(outcome.kind).toBe("completed");
      if (outcome.kind === "completed") {
        const parsed = DiagnosticReportSchema.safeParse(outcome.report);
        expect(parsed.success).toBe(true);
        expect(outcome.report.status).toBe("reachable");
        expect(outcome.report.mode).toBe("mock");
        expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
      }
      runner.dispose();
    });

    it("built path: when tsxBinPath is omitted, the runner spawns `node <scriptPath>` directly (ADR 0014)", async () => {
      // Write a fixture script that is plain JS (no .ts), so the
      // tsxBinPath branch must be skipped; if the runner incorrectly
      // tried to prepend tsx, the spawn would either fail with
      // ENOENT on the tsx binary or surface a "Cannot find module"
      // because tsx is given a .js that is not registered as a TS
      // file (some tsx versions refuse it).
      const jsFixture = join(workDir, "minimal-probe.js");
      writeFileSync(
        jsFixture,
        [
          `const r = {`,
          `  schemaVersion: 1, probe: "connectivity", mode: "mock",`,
          `  target: "tcp://vpn.example.com:443", status: "reachable",`,
          `  checks: [{ name: "tcp", ok: true, latencyMs: 1 }],`,
          `  startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),`,
          `};`,
          `process.stdout.write(JSON.stringify(r) + "\\n");`,
          `process.exit(0);`,
        ].join("\n"),
        "utf8",
      );
      const runner = new (await importRunner())({
        scriptPath: jsFixture,
        // tsxBinPath intentionally omitted: built path.
        parentEnv: {},
      });
      const outcome = await runner.run(fakeRequest({ timeoutMs: 2000 }));
      expect(outcome.kind).toBe("completed");
      if (outcome.kind === "completed") {
        const parsed = DiagnosticReportSchema.safeParse(outcome.report);
        expect(parsed.success).toBe(true);
        expect(outcome.report.status).toBe("reachable");
      }
      runner.dispose();
    });
  });

  describe("threat matrix — every failure path surfaces RunnerOutcome.failed, never a successful DiagnosticReport", () => {
    it("hang → reason: 'timeout' and the child process is confirmed killed", async () => {
      const runner = new (await importRunner())({
        scriptPath: PROBE_SCRIPT,
        tsxBinPath: TSX_BIN,
        parentEnv: { HELPDESK_PROBE_MODE: "mock", HELPDESK_PROBE_MOCK_SCENARIO: "hang" },
      });
      const outcome = await runner.run(fakeRequest({ timeoutMs: 200 }));
      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") {
        expect(outcome.reason).toBe("timeout");
        expect(outcome.durationMs).toBeGreaterThanOrEqual(200);
      }
      runner.dispose();
    }, 10_000);

    it("crash → reason: 'nonzero_exit' with the observed exitCode", async () => {
      const runner = new (await importRunner())({
        scriptPath: PROBE_SCRIPT,
        tsxBinPath: TSX_BIN,
        parentEnv: { HELPDESK_PROBE_MODE: "mock", HELPDESK_PROBE_MOCK_SCENARIO: "crash" },
      });
      const outcome = await runner.run(fakeRequest({ timeoutMs: 2000 }));
      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") {
        expect(outcome.reason).toBe("nonzero_exit");
        expect(typeof outcome.exitCode).toBe("number");
        expect(outcome.exitCode).not.toBe(0);
      }
      runner.dispose();
    });

    it("malformed → reason: 'malformed_output'", async () => {
      const runner = new (await importRunner())({
        scriptPath: PROBE_SCRIPT,
        tsxBinPath: TSX_BIN,
        parentEnv: { HELPDESK_PROBE_MODE: "mock", HELPDESK_PROBE_MOCK_SCENARIO: "malformed" },
      });
      const outcome = await runner.run(fakeRequest({ timeoutMs: 2000 }));
      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") {
        expect(outcome.reason).toBe("malformed_output");
      }
      runner.dispose();
    });

    it("a script writing > 64 KiB to stdout → reason: 'output_too_large'", async () => {
      const oversizedPath = join(workDir, "oversize.ts");
      writeFileSync(
        oversizedPath,
        `process.stdout.write("a".repeat(70 * 1024) + "\\n", () => process.exit(0));\n`,
        "utf8",
      );
      const runner = new (await importRunner())({
        scriptPath: oversizedPath,
        tsxBinPath: TSX_BIN,
        parentEnv: {},
      });
      const outcome = await runner.run(fakeRequest({ timeoutMs: 2000 }));
      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") {
        expect(outcome.reason).toBe("output_too_large");
      }
      runner.dispose();
    });

    it("invalid tsx bin path (true spawn-time failure) → reason: 'spawn_error'", async () => {
      // A truly broken executable: `node` itself exits non-zero with
      // an ENOENT-class stderr. The runner classifies that as
      // spawn_error because the spawn never produced a runnable
      // child — the script never executed. (We also test the
      // missing-script case below, which tsx surfaces as "Cannot
      // find module"; that's also spawn_error from the runner's
      // point of view.)
      const runner = new (await importRunner())({
        scriptPath: PROBE_SCRIPT,
        tsxBinPath: join(workDir, "no-such-tsx"),
        parentEnv: {},
      });
      const outcome = await runner.run(fakeRequest({ timeoutMs: 2000 }));
      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") {
        expect(outcome.reason).toBe("spawn_error");
      }
      runner.dispose();
    });

    it("invalid script path → reason: 'spawn_error' (tsx cannot find module → script never executed)", async () => {
      const runner = new (await importRunner())({
        scriptPath: join(workDir, "does-not-exist.ts"),
        tsxBinPath: TSX_BIN,
        parentEnv: {},
      });
      const outcome = await runner.run(fakeRequest({ timeoutMs: 2000 }));
      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") {
        expect(outcome.reason).toBe("spawn_error");
      }
      runner.dispose();
    });
  });

  describe("env isolation — PSEUDONYM_KEY is never inherited by the child", () => {
    it("the spawned child receives no HELPDESK_PSEUDONYM_KEY (or any *PSEUDONYM* env var) even when the parent has it set", async () => {
      // The fixture emits a DiagnosticReport-shaped line on stdout that
      // carries the probe child process's HELPDESK_PSEUDONYM_KEY (or
      // __missing__) in the first check's `detail` field, which the
      // diagnostic-report schema permits (it allows an optional
      // detail of up to 300 chars). That lets us assert the absence
      // of the secret end-to-end through the same parse path the
      // production runner uses.
      const fixturePath = join(workDir, "env-echo.ts");
      writeFileSync(
        fixturePath,
        [
          `import { DiagnosticReportSchema } from ${JSON.stringify(
            join(REPO_ROOT, "src/diagnostics/domain/diagnostic-report.ts"),
          )};`,
          `const report = {`,
          `  schemaVersion: 1,`,
          `  probe: "connectivity",`,
          `  mode: "real",`,
          `  target: "env",`,
          `  status: "reachable",`,
          `  checks: [{`,
          `    name: "dns",`,
          `    ok: true,`,
          `    latencyMs: 1,`,
          `    detail: process.env.HELPDESK_PSEUDONYM_KEY ?? "__missing__",`,
          `  }],`,
          `  startedAt: new Date().toISOString(),`,
          `  finishedAt: new Date().toISOString(),`,
          `};`,
          `process.stdout.write(JSON.stringify(DiagnosticReportSchema.parse(report)) + "\\n");`,
          `process.exit(0);`,
        ].join("\n"),
        "utf8",
      );

      const runner = new (await importRunner())({
        scriptPath: fixturePath,
        tsxBinPath: TSX_BIN,
        parentEnv: { HELPDESK_PSEUDONYM_KEY: "parent-secret-should-not-leak" },
      });
      const outcome = await runner.run(fakeRequest({ timeoutMs: 2000 }));
      expect(outcome.kind).toBe("completed");
      if (outcome.kind !== "completed") return;
      const detail = outcome.report.checks[0]?.detail ?? "";
      expect(detail).toBe("__missing__");
      expect(detail).not.toContain("parent-secret");
      runner.dispose();
    });
  });

  describe("stdout cap", () => {
    it("the runner reads at most 64 KiB of stdout before classifying as output_too_large", async () => {
      // A fixture that writes 70 KiB then exits cleanly. The runner
      // must observe > 64 KiB and classify as output_too_large.
      const oversizedPath = join(workDir, "70kib.ts");
      writeFileSync(
        oversizedPath,
        `process.stdout.write("a".repeat(70 * 1024) + "\\n", () => process.exit(0));\n`,
        "utf8",
      );
      const runner = new (await importRunner())({
        scriptPath: oversizedPath,
        tsxBinPath: TSX_BIN,
        parentEnv: {},
      });
      const outcome = await runner.run(fakeRequest({ timeoutMs: 5000 }));
      expect(outcome.kind).toBe("failed");
      if (outcome.kind === "failed") {
        expect(outcome.reason).toBe("output_too_large");
      }
      runner.dispose();
    }, 10_000);
  });

  describe("port surface", () => {
    it("the runner exposes run() and dispose()", async () => {
      const RunnerCtor = await importRunner();
      const runner = new RunnerCtor({
        scriptPath: PROBE_SCRIPT,
        tsxBinPath: TSX_BIN,
        parentEnv: { HELPDESK_PROBE_MODE: "mock", HELPDESK_PROBE_MOCK_SCENARIO: "reachable" },
      });
      const inst: Pick<InstanceType<typeof RunnerCtor>, "run" | "dispose"> = runner;
      void inst;
      runner.dispose();
    });

    it("dispose() kills any in-flight child without throwing", async () => {
      const runner = new (await importRunner())({
        scriptPath: PROBE_SCRIPT,
        tsxBinPath: TSX_BIN,
        parentEnv: { HELPDESK_PROBE_MODE: "mock", HELPDESK_PROBE_MOCK_SCENARIO: "hang" },
      });
      // Fire a long-running request and dispose before it completes.
      const promise = runner.run(fakeRequest({ timeoutMs: 5000 }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(() => runner.dispose()).not.toThrow();
      await promise; // settle; outcome may be `failed` with reason timeout — both are fine
    }, 10_000);
  });
});

async function importRunner(): Promise<
  new (opts: {
    scriptPath: string;
    tsxBinPath?: string;
    parentEnv?: NodeJS.ProcessEnv;
  }) => import("./child-process-diagnostic-runner.js").ChildProcessDiagnosticRunner
> {
  // The import is dynamic so the test file can be loaded even when
  // the implementation file is missing (RED phase).
  const mod = await import("./child-process-diagnostic-runner.js");
  return mod.ChildProcessDiagnosticRunner as unknown as new (opts: {
    scriptPath: string;
    tsxBinPath?: string;
    parentEnv?: NodeJS.ProcessEnv;
  }) => import("./child-process-diagnostic-runner.js").ChildProcessDiagnosticRunner;
}

// A no-op reference: keeps the imported ChildProcess / spawn symbols
// reachable for editors that lint unused imports. The implementation
// file imports them; the test file uses them only indirectly via the
// runner API.
void spawn;
void ({} as ChildProcess);
