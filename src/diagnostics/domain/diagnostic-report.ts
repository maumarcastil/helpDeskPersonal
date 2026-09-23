import { z } from "zod";

/** Outcome of one connectivity probe (design "Diagnostics ports and outcomes", ADR 0007). */
export type ProbeStatus = "reachable" | "degraded" | "unreachable";

const CheckSchema = z
  .object({
    name: z.enum(["dns", "tcp", "http"]),
    ok: z.boolean(),
    latencyMs: z.number().nonnegative(),
    detail: z.string().max(300).optional(),
  })
  .strict();

/**
 * The exact JSON contract the connectivity-probe script writes to stdout
 * (ADR 0007). `.strict()`: any field beyond this schema is rejected, not
 * silently ignored, so a script drifting from the contract fails loudly.
 */
export const DiagnosticReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    probe: z.literal("connectivity"),
    mode: z.enum(["real", "mock"]),
    target: z.string().max(256),
    status: z.enum(["reachable", "degraded", "unreachable"]),
    checks: z.array(CheckSchema).min(1).max(5),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
  })
  .strict();

export type DiagnosticReport = z.infer<typeof DiagnosticReportSchema>;
