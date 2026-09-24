import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, REPO_ROOT } from "./cli.js";

/**
 * task 6.11/6.12 (PR C): `cli.ts` itself stays thin wiring (parse argv, call
 * `runGenerate` from `generate.ts`, print, set `process.exitCode`), guarded
 * behind an `isMainModule` check so importing it here for `parseArgs` and
 * `REPO_ROOT` never runs `main()` against the real repository. This file
 * only tests the pure argument parsing; `generate.test.ts` covers the
 * filesystem-touching core, and the task's own manual verification step
 * runs the compiled CLI end-to-end against a real temp directory.
 */

describe("parseArgs", () => {
  it("defaults to check:false and outRoot:REPO_ROOT with no arguments", () => {
    expect(parseArgs([])).toEqual({ check: false, outRoot: REPO_ROOT });
  });

  it("--check sets check:true", () => {
    expect(parseArgs(["--check"])).toEqual({ check: true, outRoot: REPO_ROOT });
  });

  it("--out <path> resolves and overrides outRoot", () => {
    expect(parseArgs(["--out", "some/relative/dir"])).toEqual({
      check: false,
      outRoot: resolve("some/relative/dir"),
    });
  });

  it("--check and --out combine regardless of order", () => {
    expect(parseArgs(["--out", "/tmp/x", "--check"])).toEqual({ check: true, outRoot: resolve("/tmp/x") });
    expect(parseArgs(["--check", "--out", "/tmp/x"])).toEqual({ check: true, outRoot: resolve("/tmp/x") });
  });

  it("throws on an unknown argument", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/);
  });

  it("throws when --out has no following value", () => {
    expect(() => parseArgs(["--out"])).toThrow(/--out requires a path argument/);
  });
});

describe("REPO_ROOT", () => {
  it("points at the repository root (package.json lives there)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as { name?: string };
    expect(pkg.name).toBe("helpdesk-agent-ecosystem");
  });
});
