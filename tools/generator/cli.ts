#!/usr/bin/env node
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
      if (value === undefined) {
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

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
