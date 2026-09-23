import type { ImpactedService } from "../../tickets/domain/ticket.js";
import type { ProbeTarget } from "./diagnostic-runner.js";

/**
 * Resolves a ticket's `impactedService` to a concrete probe target
 * (implemented by `JsonServiceCatalog`, Phase 3, reading a committed
 * `config/service-catalog.json`). `resolve` returns `null` for an unknown
 * service — the caller (`RunDiagnostic`, task 2.15) must not invoke the
 * runner in that case and must instead produce an `escalate` decision with
 * reason `no_diagnostic_available` (spec `diagnostic-execution`).
 */
export interface ServiceCatalog {
  resolve(service: ImpactedService): ProbeTarget | null;
  list(): readonly ImpactedService[];
}
