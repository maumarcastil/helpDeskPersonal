import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { GeneratorModel } from "./definitions/schema.js";
import { claudeCodeRenderer } from "./renderers/claude-code-renderer.js";
import { opencodeRenderer } from "./renderers/opencode-renderer.js";
import { GENERATED_FILE_MARKER } from "./renderers/platform-renderer.js";
import type { PlatformRenderer, RenderedFile } from "./renderers/platform-renderer.js";
import { vscodeRenderer } from "./renderers/vscode-renderer.js";
import { assertValidated, validateModel } from "./validate.js";

/**
 * The CLI's testable core (task 6.11/6.12, PR C). Filesystem access is
 * confined to this module and `cli.ts` (never the renderers, which stay
 * pure per `platform-renderer.ts`'s doc comment): `renderAll` below is a
 * pure function of a `GeneratorModel`, while `writeRenderedFiles`,
 * `checkRenderedFiles`, and `runGenerate` touch `node:fs` and take an
 * injectable `outRoot` so tests exercise them against a real `mkdtemp`
 * temp directory instead of the repository.
 */

const RENDERERS: readonly PlatformRenderer[] = [vscodeRenderer, claudeCodeRenderer, opencodeRenderer];

export type RenderOutcome =
  | { readonly ok: true; readonly files: readonly RenderedFile[] }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Every renderer already asserts (`assertNoDuplicatePaths`) that its own
 * output has no internal path collision, and `validateModel` already
 * rejects an id colliding with a renderer's reserved synthetic id. Neither
 * check can see a collision *across* renderers, though — e.g. a future
 * renderer change emitting a literal path another renderer also happens to
 * use. This is the CLI-level backstop for exactly that: it is checked once,
 * on the combined output of all three renderers, before any file is ever
 * written.
 */
export function findCrossPlatformDuplicatePaths(
  outputs: readonly { readonly platform: string; readonly files: readonly RenderedFile[] }[],
): readonly string[] {
  const platformsByPath = new Map<string, string[]>();
  for (const { platform, files } of outputs) {
    for (const file of files) {
      const platforms = platformsByPath.get(file.path) ?? [];
      platforms.push(platform);
      platformsByPath.set(file.path, platforms);
    }
  }

  const errors: string[] = [];
  for (const [path, platforms] of platformsByPath) {
    if (platforms.length > 1) {
      errors.push(`path "${path}" is emitted by more than one renderer: ${platforms.join(", ")}`);
    }
  }
  return errors;
}

/**
 * Validates `model`, then renders it through all three platforms in
 * memory. Returns every validation error (ADR 0009: "Any failure aborts
 * the build with no files written") or every cross-renderer path
 * collision — never both a partial file list and errors.
 */
export function renderAll(model: GeneratorModel): RenderOutcome {
  const validation = validateModel(model);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }

  const validated = assertValidated(model);
  const outputs = RENDERERS.map((renderer) => ({
    platform: renderer.platform,
    files: renderer.render(validated),
  }));

  const duplicateErrors = findCrossPlatformDuplicatePaths(outputs);
  if (duplicateErrors.length > 0) {
    return { ok: false, errors: duplicateErrors };
  }

  return { ok: true, files: outputs.flatMap((output) => output.files) };
}

let temporaryFileCounter = 0;

/**
 * The generator's own output directories, listed explicitly and statically
 * (never derived from a renderer's current definitions) so that a fully
 * vacated directory or a stale leftover file is still recognized as
 * generator-owned even when nothing currently expects a file there. Deliberately
 * excludes `.claude/skills` and the repository root: those are not
 * generator output, and scanning them would risk flagging or deleting
 * unrelated, hand-maintained content.
 */
export const GENERATOR_OWNED_DIRECTORIES: readonly string[] = [
  ".github/agents",
  ".github/prompts",
  ".claude/agents",
  ".claude/commands",
  ".opencode/agents",
  ".opencode/commands",
];

/** Maps each directory that directly contains an expected `RenderedFile` to the set of file names expected there. */
function expectedNamesByDirectory(files: readonly RenderedFile[]): Map<string, Set<string>> {
  const expectedNamesByDir = new Map<string, Set<string>>();
  for (const file of files) {
    const dir = dirname(file.path);
    if (dir === ".") continue;
    const names = expectedNamesByDir.get(dir) ?? new Set<string>();
    names.add(basename(file.path));
    expectedNamesByDir.set(dir, names);
  }
  return expectedNamesByDir;
}

/**
 * Deletes a stale generated file left behind in a generator-owned directory
 * by a previous run whose definition (agent/prompt) was since removed or
 * renamed. Scans every directory in `GENERATOR_OWNED_DIRECTORIES` — not just
 * ones with an expected file this run — so a directory fully vacated by
 * this run (its last definition removed) still gets its leftovers cleaned
 * up. Only deletes a file that carries `GENERATED_FILE_MARKER`: a
 * hand-written file with no marker is left untouched even if it is not part
 * of this run's expected output, since pruning must never destroy content
 * the generator did not create. JSON outputs (`.mcp.json`,
 * `.vscode/mcp.json`, `opencode.json`) live at fixed top-level paths outside
 * any owned directory and are always rewritten in place by the loop above,
 * so they need no separate pruning step.
 */
async function pruneStaleOwnedFiles(files: readonly RenderedFile[], outRoot: string): Promise<void> {
  const expectedNamesByDir = expectedNamesByDirectory(files);

  for (const dir of GENERATOR_OWNED_DIRECTORIES) {
    const expectedNames = expectedNamesByDir.get(dir) ?? new Set<string>();
    let entries;
    try {
      entries = await readdir(join(outRoot, dir), { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isFile() || expectedNames.has(entry.name)) continue;
      const absolutePath = join(outRoot, dir, entry.name);
      let contents: string;
      try {
        contents = await readFile(absolutePath, "utf8");
      } catch (error) {
        if (isEnoent(error)) continue;
        throw error;
      }
      if (contents.includes(GENERATED_FILE_MARKER)) {
        await unlink(absolutePath);
      }
    }
  }
}

/**
 * Writes every file under `outRoot`, creating parent directories as
 * needed, then prunes stale generated files (see `pruneStaleOwnedFiles`).
 * Each file is written via a temp-file-then-rename: `writeFile` targets a
 * sibling `<path>.tmp-<pid>-<counter>` path and only then `rename`s it onto
 * the real path. `rename` within the same directory (and therefore the same
 * filesystem) is atomic on POSIX, so a reader can never observe a
 * half-written file, and replacing an existing file this way has no
 * truncate-then-write window where the file is briefly empty — unlike
 * calling `writeFile` directly on the final path. If either `writeFile` or
 * `rename` throws (ENOSPC, EPERM, a directory already at the target path,
 * ...), the sibling temp file is removed (ignoring ENOENT, in case it was
 * never created) before the error is rethrown, so a failed run never leaves
 * a `.tmp-*` file behind. The all-or-nothing guarantee this function's
 * caller (`runGenerate`) relies on is about the whole generator run
 * (nothing is written if validation fails), not about crash-safety
 * mid-write across many files; the per-file rename is the cheap,
 * dependency-free way to make each individual file's write atomic.
 */
export async function writeRenderedFiles(files: readonly RenderedFile[], outRoot: string): Promise<void> {
  for (const file of files) {
    const absolutePath = join(outRoot, file.path);
    await mkdir(dirname(absolutePath), { recursive: true });
    const temporaryPath = `${absolutePath}.tmp-${process.pid}-${temporaryFileCounter++}`;
    try {
      await writeFile(temporaryPath, file.contents, "utf8");
      await rename(temporaryPath, absolutePath);
    } catch (error) {
      await unlink(temporaryPath).catch((unlinkError: unknown) => {
        if (!isEnoent(unlinkError)) throw unlinkError;
      });
      throw error;
    }
  }

  await pruneStaleOwnedFiles(files, outRoot);
}

export type CheckDifferenceReason = "missing" | "differs" | "extra";

export interface CheckDifference {
  readonly path: string;
  readonly reason: CheckDifferenceReason;
}

export interface CheckResult {
  readonly ok: boolean;
  readonly differences: readonly CheckDifference[];
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

/**
 * Detects a hand-added or stale file inside a directory the generator
 * exclusively owns. Scoped deliberately narrow: it scans exactly
 * `GENERATOR_OWNED_DIRECTORIES` (e.g. `.claude/agents`,
 * `.opencode/commands`), never the repository root or an unrelated sibling
 * such as `.claude/skills/`. Per ADR 0009 every file directly inside one of
 * these directories belongs to the generator's output for that platform, so
 * a name it did not just render there is either a hand edit or leftover
 * drift from a previous run. Every owned directory is scanned regardless of
 * whether this run currently expects any file there — not just directories
 * with an expected file — so a directory a run has fully vacated (its last
 * definition removed) still has its leftovers reported instead of silently
 * skipped. A hand-written file with no `GENERATED_FILE_MARKER` is reported
 * exactly the same as a marked one: `checkRenderedFiles` is purely
 * informational drift detection, so it surfaces anything unexpected
 * regardless of origin; only `writeRenderedFiles`'s pruning (which may
 * delete files) restricts itself to marked ones. Nothing outside these
 * exact directories is ever inspected, so a file the generator has no
 * opinion about can never be flagged. Top-level singleton outputs (e.g.
 * `.mcp.json`, `opencode.json`) have no "directory" of their own to scan
 * for siblings and are covered by the missing/differs checks instead.
 */
async function findExtraFiles(files: readonly RenderedFile[], outRoot: string): Promise<readonly string[]> {
  const expectedNamesByDir = expectedNamesByDirectory(files);

  const extras: string[] = [];
  for (const dir of GENERATOR_OWNED_DIRECTORIES) {
    const expectedNames = expectedNamesByDir.get(dir) ?? new Set<string>();
    let entries;
    try {
      entries = await readdir(join(outRoot, dir), { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isFile() && !expectedNames.has(entry.name)) {
        extras.push(`${dir}/${entry.name}`);
      }
    }
  }
  return extras.sort();
}

/**
 * Compares `files` (already rendered in memory) against what is on disk
 * under `outRoot`. Read-only: never writes, never deletes. Returns
 * `ok:true` only when every file matches byte-for-byte and no generator-
 * owned directory holds an extra file.
 */
export async function checkRenderedFiles(files: readonly RenderedFile[], outRoot: string): Promise<CheckResult> {
  const differences: CheckDifference[] = [];

  for (const file of files) {
    let onDisk: string;
    try {
      onDisk = await readFile(join(outRoot, file.path), "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        differences.push({ path: file.path, reason: "missing" });
        continue;
      }
      throw error;
    }
    if (onDisk !== file.contents) {
      differences.push({ path: file.path, reason: "differs" });
    }
  }

  for (const extraPath of await findExtraFiles(files, outRoot)) {
    differences.push({ path: extraPath, reason: "extra" });
  }

  return { ok: differences.length === 0, differences };
}

export interface RunGenerateOptions {
  readonly outRoot: string;
  readonly check: boolean;
}

export interface RunGenerateResult {
  readonly exitCode: 0 | 1;
  readonly errors: readonly string[];
}

/**
 * The whole decision `cli.ts` needs, with no `console`/`process.exit`
 * inside it so it stays directly unit-testable: validate + render in
 * memory; on any validation error (including a cross-renderer duplicate
 * path caught by `renderAll`'s `findCrossPlatformDuplicatePaths` check),
 * exit 1 and write nothing; otherwise either compare against `outRoot`
 * (`check: true`, read-only) or write every file (`check: false`).
 */
export async function runGenerate(model: GeneratorModel, options: RunGenerateOptions): Promise<RunGenerateResult> {
  const rendered = renderAll(model);
  if (!rendered.ok) {
    return { exitCode: 1, errors: rendered.errors };
  }

  if (options.check) {
    const result = await checkRenderedFiles(rendered.files, options.outRoot);
    if (!result.ok) {
      return { exitCode: 1, errors: result.differences.map((d) => `${d.reason}: ${d.path}`) };
    }
    return { exitCode: 0, errors: [] };
  }

  await writeRenderedFiles(rendered.files, options.outRoot);
  return { exitCode: 0, errors: [] };
}
