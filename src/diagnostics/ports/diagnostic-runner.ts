import type { RunnerOutcome } from "../domain/runner-outcome.js";

/**
 * Resolved probe destination. Only ever produced by `ServiceCatalog.resolve`
 * — never supplied directly by the model or ticket text (spec
 * `diagnostic-execution` -> "Probe Target Resolution via Service Catalog").
 */
export type ProbeTarget =
  | { readonly kind: "tcp"; readonly host: string; readonly port: number }
  | { readonly kind: "http"; readonly url: string };

export interface DiagnosticRequest {
  readonly probe: "connectivity";
  readonly target: ProbeTarget;
  readonly timeoutMs: number;
}

/**
 * Spawns the connectivity-probe script as a child process (implemented by
 * `ChildProcessDiagnosticRunner`, Phase 3; script contract is ADR 0007).
 */
export interface DiagnosticRunner {
  run(request: DiagnosticRequest): Promise<RunnerOutcome>;
}
