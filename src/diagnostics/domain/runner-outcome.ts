import type { RedactedText } from "../../redaction/domain/redacted-text.js";
import type { DiagnosticReport } from "./diagnostic-report.js";

/**
 * The five runner-failure reasons spec `diagnostic-execution` -> "Diagnostic
 * Runner Contract" requires be distinguished, each a runner failure
 * distinct from a diagnostic result (a completed run whose report itself
 * says `unreachable` is NOT a runner failure).
 */
export type RunnerFailureReason =
  | "timeout"
  | "nonzero_exit"
  | "malformed_output"
  | "output_too_large"
  | "spawn_error";

export type RunnerOutcome =
  | { readonly kind: "completed"; readonly report: DiagnosticReport; readonly durationMs: number }
  | {
      readonly kind: "failed";
      readonly reason: RunnerFailureReason;
      readonly exitCode?: number;
      readonly stderrExcerpt?: RedactedText;
      readonly durationMs: number;
    };
