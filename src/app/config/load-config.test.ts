import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetPseudonymWarningLatchForTests,
  loadConfig,
} from "./load-config.js";

describe("loadConfig", () => {
  let fakeRoot: string;

  beforeEach(() => {
    __resetPseudonymWarningLatchForTests();
    fakeRoot = mkdtempSync(join(tmpdir(), "helpdesk-config-test-"));
    writeFileSync(join(fakeRoot, "package.json"), JSON.stringify({ name: "fake" }));
  });

  afterEach(() => {
    rmSync(fakeRoot, { recursive: true, force: true });
  });

  it("applies every documented default when no env vars are set", () => {
    const config = loadConfig(
      { HELPDESK_PSEUDONYM_KEY: "test-key" },
      { packageRoot: fakeRoot, stderr: { write: () => true } },
    );

    expect(config.dataDir).toBe(join(fakeRoot, "data"));
    expect(config.probeMode).toBe("mock");
    expect(config.probeTimeoutMs).toBe(3000);
    expect(config.serviceCatalogPath).toBe(join(fakeRoot, "config", "service-catalog.json"));
    expect(config.packageRoot).toBe(fakeRoot);
  });

  it("explicit env values override defaults and are validated", () => {
    const config = loadConfig(
      {
        HELPDESK_DATA_DIR: "custom-data",
        HELPDESK_PROBE_MODE: "real",
        HELPDESK_PROBE_TIMEOUT_MS: "5000",
        HELPDESK_SERVICE_CATALOG: "custom/catalog.json",
        HELPDESK_PSEUDONYM_KEY: "test-key",
      },
      { packageRoot: fakeRoot, stderr: { write: () => true } },
    );

    expect(config.dataDir).toBe(join(fakeRoot, "custom-data"));
    expect(config.probeMode).toBe("real");
    expect(config.probeTimeoutMs).toBe(5000);
    expect(config.serviceCatalogPath).toBe(join(fakeRoot, "custom", "catalog.json"));
  });

  it("rejects an invalid HELPDESK_PROBE_MODE value", () => {
    expect(() =>
      loadConfig(
        { HELPDESK_PROBE_MODE: "not-a-mode", HELPDESK_PSEUDONYM_KEY: "test-key" },
        { packageRoot: fakeRoot, stderr: { write: () => true } },
      ),
    ).toThrow();
  });

  it("resolves paths relative to the package root, not process.cwd()", () => {
    const originalCwd = process.cwd();
    const elsewhere = mkdtempSync(join(tmpdir(), "helpdesk-config-cwd-"));
    try {
      process.chdir(elsewhere);
      const config = loadConfig(
        { HELPDESK_PSEUDONYM_KEY: "test-key" },
        { packageRoot: fakeRoot, stderr: { write: () => true } },
      );
      expect(config.dataDir).toBe(join(fakeRoot, "data"));
      expect(config.dataDir.startsWith(elsewhere)).toBe(false);
    } finally {
      process.chdir(originalCwd);
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("an absolute HELPDESK_DATA_DIR is used as-is, not joined onto the package root", () => {
    const absoluteDir = join(tmpdir(), "absolute-data-dir");
    const config = loadConfig(
      { HELPDESK_DATA_DIR: absoluteDir, HELPDESK_PSEUDONYM_KEY: "test-key" },
      { packageRoot: fakeRoot, stderr: { write: () => true } },
    );
    expect(config.dataDir).toBe(absoluteDir);
  });

  describe("HELPDESK_PSEUDONYM_KEY absent", () => {
    it("uses a deterministic dev key and writes exactly one stderr warning, even across repeated loadConfig calls", () => {
      const written: string[] = [];
      const stderr = { write: (chunk: string) => written.push(chunk) };

      const first = loadConfig({}, { packageRoot: fakeRoot, stderr });
      const second = loadConfig({}, { packageRoot: fakeRoot, stderr });

      expect(first.pseudonymKey).toBe(second.pseudonymKey);
      expect(first.pseudonymKey.length).toBeGreaterThan(0);
      expect(first.pseudonymKeyIsDefault).toBe(true);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatch(/HELPDESK_PSEUDONYM_KEY/);
    });

    it("does not warn when HELPDESK_PSEUDONYM_KEY is explicitly set", () => {
      const written: string[] = [];
      const stderr = { write: (chunk: string) => written.push(chunk) };
      const config = loadConfig(
        { HELPDESK_PSEUDONYM_KEY: "explicit-key" },
        { packageRoot: fakeRoot, stderr },
      );
      expect(config.pseudonymKey).toBe("explicit-key");
      expect(config.pseudonymKeyIsDefault).toBe(false);
      expect(written).toHaveLength(0);
    });
  });
});
