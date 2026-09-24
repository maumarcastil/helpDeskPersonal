import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Resolved, validated application configuration (design "Composition root";
 * ADR 0013 - lives under `src/app/`, the cross-cutting bootstrapping
 * capability). Every path is already absolute, resolved against
 * `packageRoot` - never `process.cwd()` - so the server behaves the same
 * whether an MCP client launches it from the repo root, a user's home
 * directory, or anywhere else.
 */
export interface AppConfig {
  /** Absolute path to the directory containing this package's `package.json`. */
  readonly packageRoot: string;
  readonly dataDir: string;
  readonly probeMode: "real" | "mock";
  readonly probeTimeoutMs: number;
  readonly serviceCatalogPath: string;
  readonly pseudonymKey: string;
  /**
   * `true` when `HELPDESK_PSEUDONYM_KEY` was absent and `pseudonymKey` is
   * therefore the built-in development key. The composition root (task 4.2)
   * uses this flag to append exactly one `config.warning` audit entry.
   */
  readonly pseudonymKeyIsDefault: boolean;
}

const DEFAULT_DATA_DIR = "data";
const DEFAULT_PROBE_MODE = "mock";
const DEFAULT_PROBE_TIMEOUT_MS = 3000;
const DEFAULT_SERVICE_CATALOG = "config/service-catalog.json";

/**
 * Deterministic, obviously-not-a-secret development key. Never used in
 * production: `loadConfig` warns to stderr exactly once per process whenever
 * this key is in effect (design "if absent a dev key is used and a warning
 * is written to stderr... once").
 */
const DEV_PSEUDONYM_KEY = "dev-insecure-pseudonym-key-do-not-use-in-production";

const EnvSchema = z.object({
  HELPDESK_DATA_DIR: z.string().min(1).optional(),
  HELPDESK_PROBE_MODE: z.enum(["real", "mock"]).optional(),
  HELPDESK_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  HELPDESK_SERVICE_CATALOG: z.string().min(1).optional(),
  HELPDESK_PSEUDONYM_KEY: z.string().min(1).optional(),
});

export interface MinimalWritable {
  write(chunk: string): unknown;
}

export interface LoadConfigOptions {
  /** Override for tests; production resolves this by walking up from this
   *  module's own location until a `package.json` is found. */
  readonly packageRoot?: string;
  /** Override for tests; production writes to `process.stderr`. Stdout is
   *  reserved for the MCP protocol stream and must never receive this. */
  readonly stderr?: MinimalWritable;
}

/**
 * Walks up from `startDir` until a directory containing a `package.json` is
 * found. Works identically whether the caller is running from TypeScript
 * source (`src/app/config/load-config.ts`) or the compiled output
 * (`dist/src/app/config/load-config.js`): both are found under some
 * descendant of the real package root, just at different depths, and this
 * walk does not assume a fixed depth.
 */
export function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`could not locate a package.json walking up from "${startDir}"`);
    }
    dir = parent;
  }
}

function resolveFromRoot(root: string, value: string): string {
  return isAbsolute(value) ? value : join(root, value);
}

let warnedThisProcess = false;

/**
 * Resolves and validates every `HELPDESK_*` environment variable (design
 * "Composition root"). Defaults: `HELPDESK_DATA_DIR=data`,
 * `HELPDESK_PROBE_MODE=mock` (user override of the original "real by
 * default" design draft - see `.env.example`), `HELPDESK_PROBE_TIMEOUT_MS=3000`,
 * `HELPDESK_SERVICE_CATALOG=config/service-catalog.json`. When
 * `HELPDESK_PSEUDONYM_KEY` is absent, a deterministic development key is
 * used and exactly one warning is written to stderr for the lifetime of the
 * process, no matter how many times `loadConfig` is called - stdout is the
 * MCP transport and must stay clean. The matching `config.warning` audit
 * entry is the composition root's responsibility (task 4.2): a pure config
 * loader has no `AuditLog` to write to, and duplicating the once-only latch
 * across two modules would be harder to reason about than keeping this
 * loader dependency-free and letting the composition root own its own latch.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv,
  options: LoadConfigOptions = {},
): AppConfig {
  const parsed = EnvSchema.parse(env);
  const packageRoot =
    options.packageRoot ?? findPackageRoot(dirname(fileURLToPath(import.meta.url)));

  const pseudonymKeyIsDefault = parsed.HELPDESK_PSEUDONYM_KEY === undefined;
  if (pseudonymKeyIsDefault && !warnedThisProcess) {
    warnedThisProcess = true;
    const stderr = options.stderr ?? process.stderr;
    stderr.write(
      "[helpdesk] WARNING: HELPDESK_PSEUDONYM_KEY is not set; using an insecure " +
        "built-in development key. Set HELPDESK_PSEUDONYM_KEY before deploying.\n",
    );
  }

  return {
    packageRoot,
    dataDir: resolveFromRoot(packageRoot, parsed.HELPDESK_DATA_DIR ?? DEFAULT_DATA_DIR),
    probeMode: parsed.HELPDESK_PROBE_MODE ?? DEFAULT_PROBE_MODE,
    probeTimeoutMs: parsed.HELPDESK_PROBE_TIMEOUT_MS ?? DEFAULT_PROBE_TIMEOUT_MS,
    serviceCatalogPath: resolveFromRoot(
      packageRoot,
      parsed.HELPDESK_SERVICE_CATALOG ?? DEFAULT_SERVICE_CATALOG,
    ),
    pseudonymKey: parsed.HELPDESK_PSEUDONYM_KEY ?? DEV_PSEUDONYM_KEY,
    pseudonymKeyIsDefault,
  };
}

/** Test-only: resets the "have we already warned this process" latch so
 *  each test can observe the once-only behavior independently. */
export function __resetPseudonymWarningLatchForTests(): void {
  warnedThisProcess = false;
}
