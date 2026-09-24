import { existsSync } from "node:fs";
import { join } from "node:path";

/** Which launch path the resolved probe will use (ADR 0014). */
export type ProbeLaunchMode = "built" | "tsx";

/**
 * Resolution result for the probe's launch path:
 *
 * - `mode: "built"` — `dist/scripts/connectivity-probe.js` exists in
 *   `packageRoot` (i.e. `npm run build` has run). The runner spawns
 *   `node <scriptPath>` directly; `tsxBinPath` is `undefined` and is
 *   not consulted. This is the path ADR 0007 originally called for and
 *   the one that ships in production.
 *
 * - `mode: "tsx"` — no built artifact was found. The runner spawns
 *   `node <tsxBinPath> <scriptPath>` so the dev workflow does not
 *   require a build step.
 */
export interface ProbeLaunch {
  readonly mode: ProbeLaunchMode;
  readonly scriptPath: string;
  readonly tsxBinPath?: string;
}

/**
 * Decide which path the probe should be spawned at, relative to
 * `packageRoot` (the directory holding `package.json`).
 *
 * Precedence:
 *   1. `dist/scripts/connectivity-probe.js` if it exists.
 *   2. `scripts/connectivity-probe.ts` via `node_modules/.bin/tsx`.
 *
 * The function is pure except for one `existsSync` call: it reads the
 * filesystem to learn whether the built artifact is present. Callers
 * that need a hermetic view (tests asserting the resolver's logic
 * without touching the real filesystem) can pass a synthetic
 * `packageRoot` pointing at a controlled temp directory.
 */
export function resolveProbeLaunch(packageRoot: string): ProbeLaunch {
  const builtPath = join(packageRoot, "dist", "scripts", "connectivity-probe.js");
  if (existsSync(builtPath)) {
    return { mode: "built", scriptPath: builtPath };
  }
  return {
    mode: "tsx",
    scriptPath: join(packageRoot, "scripts", "connectivity-probe.ts"),
    tsxBinPath: join(packageRoot, "node_modules", ".bin", "tsx"),
  };
}