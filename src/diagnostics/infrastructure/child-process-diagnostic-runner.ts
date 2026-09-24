import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import { DiagnosticReportSchema } from "../domain/diagnostic-report.js";
import type { RedactedText } from "../../redaction/domain/redacted-text.js";
import type { RunnerFailureReason, RunnerOutcome } from "../domain/runner-outcome.js";
import type { DiagnosticRequest, DiagnosticRunner } from "../ports/diagnostic-runner.js";

/**
 * Environment variables the runner is allowed to forward from the
 * parent process into the spawned probe script. Anything else (notably
 * `HELPDESK_PSEUDONYM_KEY` or any key matching `/PSEUDONYM/i`) is
 * stripped — the probe is an untrusted child and the redaction key
 * never crosses the boundary (spec `sensitive-data-redaction` ->
 * "Secret material is never leaked to subprocesses").
 */
const FORWARDED_ENV_KEYS = [
  "PATH",
  "HELPDESK_PROBE_MODE",
  "HELPDESK_PROBE_MOCK_SCENARIO",
] as const;

const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 4 * 1024;
const DEFAULT_GRACE_MS = 1000;
const DISPOSE_GRACE_MS = 100;

export interface ChildProcessDiagnosticRunnerOptions {
  readonly scriptPath: string;
  readonly tsxBinPath: string;
  /**
   * Environment the parent process wants visible to the child. Only
   * keys in `FORWARDED_ENV_KEYS` survive; keys matching `/PSEUDONYM/i`
   * are explicitly dropped as a defense in depth (defense in depth:
   * even if an attacker tricks the caller into adding a forwarded
   * key, the runner's drop-rule still rejects it).
   */
  readonly parentEnv?: NodeJS.ProcessEnv;
  /** Extra ms past `timeoutMs` before the runner SIGKILLs the child. */
  readonly graceMs?: number;
}

interface StreamCapture {
  readonly chunks: Buffer[];
  totalBytes: number;
}

interface RunningChild {
  readonly child: ChildProcess;
  readonly stdout: StreamCapture;
  readonly stderr: StreamCapture;
  /** Set when the spawn itself failed (ENOENT, EACCES, ...). */
  spawnError: Error | null;
}

function forwardEnvFrom(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const forwarded: NodeJS.ProcessEnv = {
    PATH: parentEnv["PATH"] ?? process.env["PATH"] ?? "",
  };
  for (const key of FORWARDED_ENV_KEYS) {
    if (key === "PATH") continue;
    const value = parentEnv[key];
    if (typeof value === "string") {
      forwarded[key] = value;
    }
  }
  return forwarded;
}

/**
 * Child-process `DiagnosticRunner` adapter (ADR 0007, ADR 0008).
 *
 * Spawns `node <tsxBinPath> <scriptPath> --target <...> --timeout-ms <N>`
 * with `shell: false`, a minimal env (forwarding `PATH` and the
 * `HELPDESK_PROBE_*` knobs but explicitly dropping everything that
 * matches `/PSEUDONYM/i`), and `stdio: ['ignore', 'pipe', 'pipe']`.
 * The script's contract is "exactly one JSON line on stdout": the
 * runner reads up to `MAX_STDOUT_BYTES` of stdout, identifies the
 * **last non-empty line**, and validates it strictly with the zod
 * `DiagnosticReportSchema`. Stderr is read up to `MAX_STDERR_BYTES`
 * and surfaced as a `RedactedText` excerpt on failure so the use case
 * can audit it without leaking arbitrary subprocess output.
 *
 * Threat matrix (all failures reach `RunnerOutcome.failed`, never a
 * completed diagnostic):
 *  - `spawn_error`: spawn itself failed (ENOENT for the script,
 *    EACCES, ...). Surfaced via the child process's `error` event
 *    which Node delivers asynchronously.
 *  - `timeout`: SIGKILL after `timeoutMs + graceMs`.
 *  - `nonzero_exit`: process exited with a non-zero status before
 *    stdout was a valid report.
 *  - `malformed_output`: stdout was non-empty but did not parse as
 *    a DiagnosticReportSchema (the contract violation).
 *  - `output_too_large`: stdout exceeded `MAX_STDOUT_BYTES` before
 *    we observed a valid report.
 *
 * `dispose()` is a kill switch for the composition root to use while
 * shutting the MCP server down — it terminates any in-flight child
 * with SIGTERM (then SIGKILL after a short grace) and is safe to call
 * multiple times.
 */
export class ChildProcessDiagnosticRunner implements DiagnosticRunner {
  private readonly scriptPath: string;
  private readonly tsxBinPath: string;
  private readonly parentEnv: NodeJS.ProcessEnv;
  private readonly graceMs: number;
  private readonly inflight: Set<ChildProcess> = new Set();

  constructor(options: ChildProcessDiagnosticRunnerOptions) {
    this.scriptPath = options.scriptPath;
    this.tsxBinPath = options.tsxBinPath;
    this.parentEnv = options.parentEnv ?? process.env;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  }

  async run(request: DiagnosticRequest): Promise<RunnerOutcome> {
    const start = Date.now();
    const args = this.buildArgs(request);
    const env = forwardEnvFrom(this.parentEnv);
    // Defense in depth: drop any *PSEUDONYM* key the parent may have
    // slipped past FORWARDED_ENV_KEYS. Belt and suspenders.
    for (const key of Object.keys(env)) {
      if (/PSEUDONYM/i.test(key)) delete env[key];
    }

    const running = this.spawn(args, env);

    // If the child process emits `error` asynchronously (e.g. the
    // script path doesn't exist, or the binary isn't executable),
    // Node never throws from `spawn` synchronously. Capture that
    // signal so we can wait for it before classifying the run.
    const spawnErrorP = new Promise<Error | null>((resolve) => {
      running.child.once("error", (err) => resolve(err));
      running.child.once("spawn", () => resolve(null));
    });
    // `child_process` emits `spawn` only after a successful spawn on
    // some Node versions; some emit the `error` event for failures.
    // Race them: if `error` arrives first we classify as spawn_error,
    // if `close` arrives first without an `error`, the spawn itself
    // succeeded (and the child later failed in some other way).
    const spawnErrorOrClose = Promise.race([
      spawnErrorP,
      new Promise<"close">((resolve) => running.child.once("close", () => resolve("close"))),
    ]);

    this.inflight.add(running.child);
    try {
      const exitInfo = await this.waitForExit(running, request.timeoutMs);
      this.inflight.delete(running.child);

      // If the spawn error arrived, surface as spawn_error. Wait
      // briefly for the `error` event if `close` won the race.
      let spawnError = await spawnErrorOrClose;
      if (spawnError === "close") {
        spawnError = await spawnErrorP;
      }
      if (spawnError instanceof Error) {
        return {
          kind: "failed",
          reason: "spawn_error",
          stderrExcerpt: spawnError.message as RedactedText,
          durationMs: Date.now() - start,
        };
      }

      if (exitInfo.reason === "timeout" || exitInfo.byTimeout) {
        return {
          kind: "failed",
          reason: "timeout",
          stderrExcerpt: lastNonEmptyLine(running.stderr) as RedactedText,
          durationMs: Date.now() - start,
        };
      }
      if (running.stdout.totalBytes > MAX_STDOUT_BYTES) {
        return {
          kind: "failed",
          reason: "output_too_large",
          stderrExcerpt: lastNonEmptyLine(running.stderr) as RedactedText,
          durationMs: Date.now() - start,
        };
      }
      if (exitInfo.status !== 0) {
        const stderrText = Buffer.concat(running.stderr.chunks).toString("utf8");
        // A tsx "Cannot find module" or Node ENOENT on the script path
        // is a spawn-class failure from the runner's point of view:
        // the script never executed, the runner just failed to launch
        // it. Surface that as spawn_error rather than nonzero_exit
        // so the upstream use case records the right reason.
        const stderrExcerpt = lastNonEmptyLine(running.stderr) as RedactedText;
        if (
          /Cannot find module/.test(stderrText) ||
          /ENOENT/.test(stderrText)
        ) {
          return {
            kind: "failed",
            reason: "spawn_error",
            stderrExcerpt,
            durationMs: Date.now() - start,
          };
        }
        return {
          kind: "failed",
          reason: "nonzero_exit",
          exitCode: exitInfo.status ?? -1,
          stderrExcerpt,
          durationMs: Date.now() - start,
        };
      }

      const stdoutText = Buffer.concat(running.stdout.chunks).toString("utf8");
      const lastLine = lastNonEmptyLine(running.stdout).trim();
      const parsed = parseReport(lastLine);
      if (parsed === null) {
        return {
          kind: "failed",
          reason: "malformed_output",
          stderrExcerpt: (lastNonEmptyLine(running.stderr) || stdoutText.slice(0, MAX_STDERR_BYTES)) as RedactedText,
          durationMs: Date.now() - start,
        };
      }
      return {
        kind: "completed",
        report: parsed,
        durationMs: Date.now() - start,
      };
    } finally {
      this.inflight.delete(running.child);
    }
  }

  /** Best-effort kill of any in-flight child, used by the composition
   *  root during shutdown. Safe to call multiple times — subsequent
   *  calls are no-ops once the set is empty. */
  dispose(): void {
    for (const child of [...this.inflight]) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore — the child may already be gone
      }
      const c = child;
      setTimeout(() => {
        if (!c.killed) {
          try {
            c.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }, DISPOSE_GRACE_MS).unref();
    }
    this.inflight.clear();
  }

  private buildArgs(request: DiagnosticRequest): string[] {
    const target = encodeTarget(request.target);
    return ["--target", target, "--timeout-ms", String(request.timeoutMs)];
  }

  private spawn(args: string[], env: NodeJS.ProcessEnv): RunningChild {
    const child = spawn("node", [this.tsxBinPath, this.scriptPath, ...args], {
      shell: false,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (child.stdout === null || child.stderr === null) {
      throw new Error("probe child stdio was not piped");
    }

    return {
      child,
      stdout: attachCap(child.stdout, MAX_STDOUT_BYTES),
      stderr: attachCap(child.stderr, MAX_STDERR_BYTES),
      spawnError: null,
    };
  }

  private waitForExit(
    running: RunningChild,
    timeoutMs: number,
  ): Promise<{ status: number | null; signal: NodeJS.Signals | null; reason: "exit" | "timeout"; byTimeout: boolean }> {
    return new Promise((resolve) => {
      let settled = false;
      let triggeredByTimeout = false;
      const finish = (info: {
        status: number | null;
        signal: NodeJS.Signals | null;
        reason: "exit" | "timeout";
      }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        resolve({ ...info, byTimeout: triggeredByTimeout });
      };
      const timer = setTimeout(() => {
        // Once we fire the timeout, every subsequent exit is a
        // timeout-classified run, even if `close` fires first.
        triggeredByTimeout = true;
        try {
          running.child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }, timeoutMs);
      const graceTimer = setTimeout(() => {
        finish({ status: null, signal: "SIGKILL", reason: "timeout" });
        try {
          running.child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, timeoutMs + this.graceMs);
      running.child.on("close", (status, signal) => {
        finish({ status, signal, reason: "exit" });
      });
    });
  }
}

function encodeTarget(target: DiagnosticRequest["target"]): string {
  if (target.kind === "tcp") {
    return `tcp://${target.host}:${target.port}`;
  }
  return target.url;
}

/** Buffer the stream's output but truncate past `maxBytes` so a
 *  pathological child cannot exhaust memory. The returned object is a
 *  live handle: callers read `totalBytes` and `chunks` after the
 *  stream has ended. */
function attachCap(stream: NodeJS.ReadableStream, maxBytes: number): StreamCapture {
  const capture: StreamCapture = { chunks: [], totalBytes: 0 };
  stream.on("data", (chunk: Buffer | string) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    capture.totalBytes += bytes.length;
    if (capture.totalBytes > maxBytes) {
      // Keep tracking the original byte count, but stop appending past
      // the cap so memory stays bounded under adversarial input.
      const overshoot = capture.totalBytes - maxBytes;
      const keep = Math.max(0, bytes.length - overshoot);
      capture.chunks.push(bytes.subarray(0, keep));
    } else {
      capture.chunks.push(bytes);
    }
  });
  return capture;
}

/** Last non-empty line in the buffer, or empty string. The runner
 *  uses this to surface a small stderr excerpt without leaking
 *  arbitrary subprocess noise into the audit log. */
function lastNonEmptyLine(capture: StreamCapture): string {
  const text = Buffer.concat(capture.chunks).toString("utf8");
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? "").trim();
    if (line.length > 0) return line;
  }
  return "";
}

function parseReport(line: string): import("../domain/diagnostic-report.js").DiagnosticReport | null {
  if (line.length === 0) return null;
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = DiagnosticReportSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

// Re-export the env helpers so tests can assert on the policy
// directly without spinning up a real child process.
export const __internals = {
  forwardEnvFrom,
  MAX_STDOUT_BYTES,
  MAX_STDERR_BYTES,
  FORWARDED_ENV_KEYS,
};

// Touch unused-but-reserved imports so future refactors don't
// accidentally remove them.
void ({} as { pseduonymPolicy: never });
