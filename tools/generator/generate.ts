import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { GeneratorModel } from "./definitions/schema.js";
import { claudeCodeRenderer } from "./renderers/claude-code-renderer.js";
import { opencodeRenderer } from "./renderers/opencode-renderer.js";
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
 * Writes every file under `outRoot`, creating parent directories as
 * needed. Each file is written via a temp-file-then-rename: `writeFile`
 * targets a sibling `<path>.tmp-<pid>-<counter>` path and only then
 * `rename`s it onto the real path. `rename` within the same directory (and
 * therefore the same filesystem) is atomic on POSIX, so a reader can never
 * observe a half-written file, and replacing an existing file this way has
 * no truncate-then-write window where the file is briefly empty — unlike
 * calling `writeFile` directly on the final path. The all-or-nothing
 * guarantee this function's caller (`runGenerate`) relies on is about the
 * whole generator run (nothing is written if validation fails), not about
 * crash-safety mid-write across many files; the per-file rename is the
 * cheap, dependency-free way to make each individual file's write atomic.
 */
export async function writeRenderedFiles(files: readonly RenderedFile[], outRoot: string): Promise<void> {
  for (const file of files) {
    const absolutePath = join(outRoot, file.path);
    await mkdir(dirname(absolutePath), { recursive: true });
    const temporaryPath = `${absolutePath}.tmp-${process.pid}-${temporaryFileCounter++}`;
    await writeFile(temporaryPath, file.contents, "utf8");
    await rename(temporaryPath, absolutePath);
  }
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
 * exclusively owns. Scoped deliberately narrow: it lists only the exact
 * directories that directly contain an expected `RenderedFile` (e.g.
 * `.claude/agents`, `.opencode/commands`), never the repository root or an
 * unrelated sibling such as `.claude/skills/`. Per ADR 0009 every file
 * directly inside one of these directories belongs to the generator's
 * output for that platform, so a name it did not just render there is
 * either a hand edit or leftover drift from a previous run — and nothing
 * outside these exact directories is ever inspected, so a file the
 * generator has no opinion about can never be flagged. Top-level singleton
 * outputs (e.g. `.mcp.json`, `opencode.json`) have no "directory" of their
 * own to scan for siblings and are covered by the missing/differs checks
 * instead.
 */
async function findExtraFiles(files: readonly RenderedFile[], outRoot: string): Promise<readonly string[]> {
  const expectedNamesByDir = new Map<string, Set<string>>();
  for (const file of files) {
    const dir = dirname(file.path);
    if (dir === ".") continue;
    const names = expectedNamesByDir.get(dir) ?? new Set<string>();
    names.add(basename(file.path));
    expectedNamesByDir.set(dir, names);
  }

  const extras: string[] = [];
  for (const [dir, expectedNames] of expectedNamesByDir) {
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
 * memory; on any validation error, exit 1 and write nothing; otherwise
 * either compare against `outRoot` (`check: true`, read-only) or write
 * every file (`check: false`).
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
