import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./cli.js";
import { MODEL } from "./definitions/index.js";
import { GENERATOR_OWNED_DIRECTORIES, checkRenderedFiles, renderAll } from "./generate.js";

/**
 * Task 7.1: the repo-level drift guard ADR 0009 requires ("generated files
 * committed and guarded against drift"). Unlike `generate.test.ts`, which
 * exercises `checkRenderedFiles`/`writeRenderedFiles` against a disposable
 * `mkdtemp` root, this file runs the real generator model's check mode
 * against the actual checked-out repository root (`REPO_ROOT`) — the same
 * comparison `npm run generate:check` performs — so a hand-edit, a stale
 * leftover, or a forgotten `npm run generate` after a definition change
 * fails `npm test`, not just a separate CI step. It imports `checkRenderedFiles`
 * directly rather than shelling out to the CLI: `runGenerate`'s core is
 * already a pure-enough, directly callable function, and importing it keeps
 * this test fast and gives a structured `CheckResult` instead of parsing
 * captured stdout.
 */
describe("repo drift: generated output matches the real repository", () => {
  it("renders the real model with no validation errors", () => {
    const result = renderAll(MODEL);
    expect(result.ok).toBe(true);
  });

  it("has zero missing, differing, or extra files against the checked-out repo root", async () => {
    const rendered = renderAll(MODEL);
    if (!rendered.ok) throw new Error("unreachable: covered by the previous test");

    const result = await checkRenderedFiles(rendered.files, REPO_ROOT);

    expect(result.differences).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

/**
 * PR #16 review follow-up: `checkRenderedFiles`/`writeRenderedFiles` only
 * scan `GENERATOR_OWNED_DIRECTORIES` for extras/pruning, plus three fixed
 * top-level JSON paths handled by the missing/differs comparison
 * (`.mcp.json`, `.vscode/mcp.json`, `opencode.json`). A future renderer that
 * started emitting a file outside both of those would silently escape the
 * extra-file/prune scan — checkRenderedFiles would report it neither missing
 * nor extra as long as it happened to match on disk, and a hand-edit to it
 * would never be caught as "extra" if its definition were later removed.
 * This test locks that invariant at the whole-model level, independent of
 * `GENERATOR_OWNED_DIRECTORIES`'s current contents, so adding a renderer
 * output path without also covering it here (by owned directory or by
 * adding it to the fixed-path allowlist) fails loudly instead of silently
 * under-scanning.
 */
describe("every rendered file stays inside owned/checked territory (PR #16 follow-up)", () => {
  const FIXED_JSON_PATHS: readonly string[] = [".mcp.json", ".vscode/mcp.json", "opencode.json"];

  it("every file from every renderer is inside a GENERATOR_OWNED_DIRECTORIES entry or a fixed JSON path", () => {
    const rendered = renderAll(MODEL);
    if (!rendered.ok) throw new Error("unreachable: covered by the first describe block");

    const uncovered = rendered.files.filter((file) => {
      if (FIXED_JSON_PATHS.includes(file.path)) return false;
      const dir = dirname(file.path);
      return !GENERATOR_OWNED_DIRECTORIES.includes(dir);
    });

    expect(uncovered.map((f) => f.path)).toEqual([]);
  });
});
