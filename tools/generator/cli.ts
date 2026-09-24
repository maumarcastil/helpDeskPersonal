#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { MODEL } from "./definitions/index.js";
import { runGenerate } from "./generate.js";

/**
 * The CLI (task 6.11/6.12, PR C). Deliberately thin: it only resolves
 * `argv`/the default output root and wires `generate.ts`'s pure/testable
 * core to `console`/`process.exitCode` — the actual validate-render-write
 * decision (`runGenerate`) is unit-tested directly against a temp
 * directory in `generate.test.ts`, never by spawning this file. `main()`
 * is guarded by `isMainModule` below so importing `parseArgs`/`REPO_ROOT`
 * from a test (`cli.test.ts`) never runs it against the real repository.
 */

/** The repository root: two directories up from this file (`tools/generator/cli.ts`). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface ParsedArgs {
  readonly check: boolean;
  readonly outRoot: string;
}

/**
 * `npm run generate` (no flags): render + write under `REPO_ROOT`.
 * `npm run generate:check` (`--check`): render + compare, write nothing.
 * `--out <path>` overrides the output root (used by the task's manual
 * verification step, and mirrors how `writeRenderedFiles`/
 * `checkRenderedFiles` in `generate.ts` already take an injectable root).
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let check = false;
  let outRoot = REPO_ROOT;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--out") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--out requires a path argument");
      }
      outRoot = resolve(value);
      i++;
      continue;
    }
    throw new Error(`unknown argument: "${arg}"`);
  }

  return { check, outRoot };
}

async function main(): Promise<void> {
  const { check, outRoot } = parseArgs(process.argv.slice(2));
  const { exitCode, errors } = await runGenerate(MODEL, { outRoot, check });
  for (const error of errors) {
    console.error(error);
  }
  process.exitCode = exitCode;
}

/**
 * `fs.realpathSync`, falling back to the input path unchanged if it cannot
 * be resolved (e.g. it does not exist). Used by `isMainModulePath` so a
 * lookup failure degrades to the pre-fix, non-realpath comparison instead
 * of throwing out of a module-load-time computation.
 */
function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Whether `argv1` (raw, exactly as the shell/loader passed it) names the
 * same file as `moduleFilePath` (the running module's own path). Compares
 * `fs.realpathSync` of *both* sides rather than a plain string/`resolve`
 * comparison: `fileURLToPath(import.meta.url)` on the module side is
 * typically already symlink-resolved by Node's loader, while `argv[1]` is
 * whatever the invoking shell literally passed — e.g. a symlinked bin entry,
 * or a macOS path through `/var` (itself a symlink to `/private/var`). A
 * bare `resolve()` comparison mismatches in exactly that case, causing
 * `main()` to silently never run (task 6.13b, PR C review finding).
 */
export function isMainModulePath(moduleFilePath: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  return safeRealpath(moduleFilePath) === safeRealpath(resolve(argv1));
}

const isMainModule = isMainModulePath(fileURLToPath(import.meta.url), process.argv[1]);

if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
