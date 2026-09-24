import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ImpactedService } from "../../tickets/domain/ticket.js";
import type { ProbeTarget } from "../ports/diagnostic-runner.js";
import type { ServiceCatalog } from "../ports/service-catalog.js";

/**
 * Single source of truth for every connectivity probe target the help
 * desk agent may resolve. The catalog is **committed** to the repo as
 * `config/service-catalog.json` — models, ticket text, and external
 * callers never supply a host (spec `diagnostic-execution` ->
 * "Probe Target Resolution via Service Catalog"), so an attacker who
 * smuggles a URL through ticket text cannot turn this runner into an
 * SSRF primitive; the only hosts reachable from the diagnostic runner
 * are the ones in this file.
 *
 * The schema is `.strict()` so an unanticipated field on a probe entry
 * (a stale `user` or `method`, an unused `https://` alias, an LLM-
 * injected extra key) is rejected at load time rather than silently
 * ignored. Validation happens **synchronously in the constructor**, so
 * an invalid catalog fails the process at boot — never reaches a
 * runner call.
 *
 * `probe: null` on a service means "no allowlisted remediation; the
 * use case must escalate with reason `no_diagnostic_available`". The
 * catalog returns `null` from `resolve` in that case so `RunDiagnostic`
 * short-circuits, exactly the same `resolve -> null` branch an unknown
 * service hits.
 */

const PROBE_SCHEME = z.enum(["tcp", "http", "https"]);

const ProbeSpecSchema = z
  .object({
    scheme: PROBE_SCHEME,
    host: z.string().min(1, "probe.host is required"),
    port: z
      .number()
      .int()
      .min(1, "probe.port must be in [1, 65535]")
      .max(65535, "probe.port must be in [1, 65535]"),
    path: z
      .string()
      .startsWith("/", "probe.path must start with '/'")
      .optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const ServiceEntrySchema = z
  .object({
    displayName: z.string().min(1),
    category: z.string().min(1),
    subcategory: z.string().min(1),
    probe: ProbeSpecSchema.nullable(),
  })
  .strict();

const ServiceCatalogFileSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    services: z.record(z.string(), ServiceEntrySchema),
  })
  .strict();

type ProbeSpec = z.infer<typeof ProbeSpecSchema>;
type ServiceCatalogFile = z.infer<typeof ServiceCatalogFileSchema>;
type ServiceEntry = z.infer<typeof ServiceEntrySchema>;

interface ResolvedService {
  readonly id: ImpactedService;
  readonly target: ProbeTarget | null;
}

function probeToTarget(probe: ProbeSpec): ProbeTarget {
  if (probe.scheme === "tcp") {
    return { kind: "tcp", host: probe.host, port: probe.port };
  }
  const path = probe.path ?? "";
  return {
    kind: "http",
    url: `${probe.scheme}://${probe.host}:${probe.port}${path}`,
  };
}

export class JsonServiceCatalog implements ServiceCatalog {
  private readonly resolved: ReadonlyMap<ImpactedService, ResolvedService>;

  constructor(catalogPath: string) {
    const raw = readFileSync(catalogPath, "utf8");
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `service catalog at ${catalogPath} is not valid JSON: ${reason}`,
      );
    }
    const parsed = ServiceCatalogFileSchema.safeParse(parsedJson);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw new Error(
        `service catalog at ${catalogPath} failed validation: ${issues}`,
      );
    }
    const file: ServiceCatalogFile = parsed.data;
    const map = new Map<ImpactedService, ResolvedService>();
    for (const [id, entry] of Object.entries(file.services) as [
      string,
      ServiceEntry,
    ][]) {
      const target = entry.probe === null ? null : probeToTarget(entry.probe);
      map.set(id, { id, target });
    }
    this.resolved = map;
  }

  resolve(service: ImpactedService): ProbeTarget | null {
    return this.resolved.get(service)?.target ?? null;
  }

  list(): readonly ImpactedService[] {
    return [...this.resolved.keys()];
  }
}
