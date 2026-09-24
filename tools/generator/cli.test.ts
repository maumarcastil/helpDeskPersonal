import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMainModulePath, parseArgs, REPO_ROOT } from "./cli.js";

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

  it("throws when --out is immediately followed by another flag instead of a path", () => {
    expect(() => parseArgs(["--out", "--check"])).toThrow(/--out requires a path argument/);
  });
});

describe("isMainModulePath", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "helpdesk-cli-symlink-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns false when argv[1] is undefined", () => {
    expect(isMainModulePath("/some/module.js", undefined)).toBe(false);
  });

  it("returns false for unrelated paths", () => {
    expect(isMainModulePath("/some/module.js", "/some/other.js")).toBe(false);
  });

  it("returns true when argv[1] is a symlink resolving to the same real file as the module path", async () => {
    const real = join(dir, "cli-real.mjs");
    const link = join(dir, "cli-link.mjs");
    await writeFile(real, "export {};\n", "utf8");
    await symlink(real, link);

    expect(isMainModulePath(real, link)).toBe(true);
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
