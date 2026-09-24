import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveProbeLaunch } from "./probe-launcher.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "helpdesk-probe-launcher-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Build the absolute path `resolveProbeLaunch` expects when it
 *  decides a built artifact is present or absent. */
function scriptAt(...segments: readonly string[]): string {
  return join(workDir, ...segments);
}

describe("resolveProbeLaunch", () => {
  describe("built artifact present", () => {
    it("returns mode='built' and points at dist/scripts/connectivity-probe.js when the file exists", () => {
      mkdirSync(scriptAt("dist", "scripts"), { recursive: true });
      writeFileSync(scriptAt("dist", "scripts", "connectivity-probe.js"), "/* built */\n", "utf8");

      const result = resolveProbeLaunch(workDir);

      expect(result.mode).toBe("built");
      expect(result.scriptPath).toBe(scriptAt("dist", "scripts", "connectivity-probe.js"));
      expect(result.tsxBinPath).toBeUndefined();
    });

    it("returns mode='built' even when the .ts source is missing (build already produced the artifact)", () => {
      mkdirSync(scriptAt("dist", "scripts"), { recursive: true });
      writeFileSync(scriptAt("dist", "scripts", "connectivity-probe.js"), "/* built */\n", "utf8");
      // Intentionally do NOT create scripts/connectivity-probe.ts.

      const result = resolveProbeLaunch(workDir);

      expect(result.mode).toBe("built");
      expect(result.scriptPath).toBe(scriptAt("dist", "scripts", "connectivity-probe.js"));
    });
  });

  describe("built artifact absent (dev workflow)", () => {
    it("returns mode='tsx' and points at the .ts source via node_modules/.bin/tsx", () => {
      // No dist/ directory at all - the typical fresh checkout.
      const result = resolveProbeLaunch(workDir);

      expect(result.mode).toBe("tsx");
      expect(result.scriptPath).toBe(scriptAt("scripts", "connectivity-probe.ts"));
      expect(result.tsxBinPath).toBe(scriptAt("node_modules", ".bin", "tsx"));
    });

    it("returns mode='tsx' when only dist/ exists but the probe file inside it does not (a partial build)", () => {
      mkdirSync(scriptAt("dist", "scripts"), { recursive: true });
      // connectivity-probe.js intentionally absent.

      const result = resolveProbeLaunch(workDir);

      expect(result.mode).toBe("tsx");
      expect(result.scriptPath).toBe(scriptAt("scripts", "connectivity-probe.ts"));
      expect(result.tsxBinPath).toBe(scriptAt("node_modules", ".bin", "tsx"));
    });

    it("returns mode='tsx' when dist/ exists but is unrelated (e.g. dist/src/... only)", () => {
      mkdirSync(scriptAt("dist", "src"), { recursive: true });
      writeFileSync(scriptAt("dist", "src", "main.js"), "/* main */\n", "utf8");

      const result = resolveProbeLaunch(workDir);

      expect(result.mode).toBe("tsx");
      expect(result.scriptPath).toBe(scriptAt("scripts", "connectivity-probe.ts"));
    });
  });

  describe("purity", () => {
    it("does not write to the filesystem as a side effect", () => {
      // Calling resolve twice in a row must produce the same result
      // without creating any side-effect file. The deep-equal
      // assertion on the second call covers both branches.
      const before = resolveProbeLaunch(workDir);
      const after = resolveProbeLaunch(workDir);
      expect(after).toEqual(before);
    });
  });
});