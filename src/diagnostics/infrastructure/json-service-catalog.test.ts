import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonServiceCatalog } from "./json-service-catalog.js";

let workDir: string;
let catalogPath: string;

beforeEach(() => {
  const dir = join(tmpdir(), `helpdesk-catalog-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  workDir = dir;
  catalogPath = join(dir, "service-catalog.json");
});

afterEach(() => {
  if (existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

const VALID_CATALOG = {
  $schema: "internal",
  version: 1,
  services: {
    "vpn-gateway": {
      displayName: "Corporate VPN gateway",
      category: "infrastructure-software",
      subcategory: "vpn",
      probe: {
        scheme: "tcp",
        host: "vpn.example.com",
        port: 443,
        timeoutMs: 3000,
      },
    },
    idp: {
      displayName: "Identity provider (SSO)",
      category: "access-identity",
      subcategory: "account-locked",
      probe: {
        scheme: "https",
        host: "idp.example.com",
        port: 443,
        path: "/healthz",
        timeoutMs: 3000,
      },
    },
    "internal-app": {
      displayName: "Corporate internal app",
      category: "infrastructure-software",
      subcategory: "corporate-app",
      probe: {
        scheme: "https",
        host: "app.internal.example.com",
        port: 443,
        path: "/health",
        timeoutMs: 3000,
      },
    },
    "shared-drive": {
      displayName: "Shared drive provisioning",
      category: "provisioning-permissions",
      subcategory: "folder-repo-access",
      probe: null,
    },
  },
};

function writeCatalog(content: unknown): void {
  writeFileSync(catalogPath, JSON.stringify(content, null, 2), "utf8");
}

function writeString(raw: string): void {
  writeFileSync(catalogPath, raw, "utf8");
}

describe("JsonServiceCatalog", () => {
  describe("resolve — known services", () => {
    it("resolve('vpn-gateway') returns the configured tcp ProbeTarget (host + port)", () => {
      writeCatalog(VALID_CATALOG);
      const catalog = new JsonServiceCatalog(catalogPath);

      const target = catalog.resolve("vpn-gateway");
      expect(target).toEqual({
        kind: "tcp",
        host: "vpn.example.com",
        port: 443,
      });
    });

    it("resolve('idp') returns the configured http ProbeTarget built from scheme/host/port/path", () => {
      writeCatalog(VALID_CATALOG);
      const catalog = new JsonServiceCatalog(catalogPath);

      const target = catalog.resolve("idp");
      expect(target).toEqual({
        kind: "http",
        url: "https://idp.example.com:443/healthz",
      });
    });

    it("resolve('internal-app') returns the configured http ProbeTarget with a /health path", () => {
      writeCatalog(VALID_CATALOG);
      const catalog = new JsonServiceCatalog(catalogPath);

      const target = catalog.resolve("internal-app");
      expect(target).toEqual({
        kind: "http",
        url: "https://app.internal.example.com:443/health",
      });
    });

    it("resolve('shared-drive') returns null (no probe → runner is not invoked → escalate path)", () => {
      writeCatalog(VALID_CATALOG);
      const catalog = new JsonServiceCatalog(catalogPath);

      const target = catalog.resolve("shared-drive");
      expect(target).toBeNull();
    });
  });

  describe("resolve — unknown service", () => {
    it("resolve('unknown-service') returns null (not in the catalog)", () => {
      writeCatalog(VALID_CATALOG);
      const catalog = new JsonServiceCatalog(catalogPath);

      const target = catalog.resolve("unknown-service");
      expect(target).toBeNull();
    });
  });

  describe("list", () => {
    it("list() returns every configured service id", () => {
      writeCatalog(VALID_CATALOG);
      const catalog = new JsonServiceCatalog(catalogPath);

      const ids = catalog.list();
      expect([...ids].sort()).toEqual(
        ["idp", "internal-app", "shared-drive", "vpn-gateway"].sort(),
      );
    });

    it("list() on an empty services record returns an empty array", () => {
      writeCatalog({ $schema: "internal", version: 1, services: {} });
      const catalog = new JsonServiceCatalog(catalogPath);

      expect(catalog.list()).toEqual([]);
    });
  });

  describe("load-time validation (fail-fast defense)", () => {
    it("throws on an out-of-range port (>65535)", () => {
      writeCatalog({
        $schema: "internal",
        version: 1,
        services: {
          bad: {
            displayName: "Bad",
            category: "infrastructure-software",
            subcategory: "vpn",
            probe: { scheme: "tcp", host: "vpn.example.com", port: 70000, timeoutMs: 3000 },
          },
        },
      });
      expect(() => new JsonServiceCatalog(catalogPath)).toThrow();
    });

    it("throws on an out-of-range port (=0)", () => {
      writeCatalog({
        $schema: "internal",
        version: 1,
        services: {
          bad: {
            displayName: "Bad",
            category: "infrastructure-software",
            subcategory: "vpn",
            probe: { scheme: "tcp", host: "vpn.example.com", port: 0, timeoutMs: 3000 },
          },
        },
      });
      expect(() => new JsonServiceCatalog(catalogPath)).toThrow();
    });

    it("throws on a missing host", () => {
      writeCatalog({
        $schema: "internal",
        version: 1,
        services: {
          bad: {
            displayName: "Bad",
            category: "infrastructure-software",
            subcategory: "vpn",
            probe: { scheme: "tcp", host: "", port: 443, timeoutMs: 3000 },
          },
        },
      });
      expect(() => new JsonServiceCatalog(catalogPath)).toThrow();
    });

    it("throws on a host field missing entirely", () => {
      writeCatalog({
        $schema: "internal",
        version: 1,
        services: {
          bad: {
            displayName: "Bad",
            category: "infrastructure-software",
            subcategory: "vpn",
            probe: { scheme: "tcp", port: 443, timeoutMs: 3000 },
          },
        },
      });
      expect(() => new JsonServiceCatalog(catalogPath)).toThrow();
    });

    it("throws on a scheme outside tcp|http|https", () => {
      writeCatalog({
        $schema: "internal",
        version: 1,
        services: {
          bad: {
            displayName: "Bad",
            category: "infrastructure-software",
            subcategory: "vpn",
            probe: { scheme: "ftp", host: "vpn.example.com", port: 443, timeoutMs: 3000 },
          },
        },
      });
      expect(() => new JsonServiceCatalog(catalogPath)).toThrow();
    });

    it("throws on malformed JSON (catalog file is not parseable)", () => {
      writeString("{ not valid json");
      expect(() => new JsonServiceCatalog(catalogPath)).toThrow();
    });

    it("throws on a path that does not start with /", () => {
      writeCatalog({
        $schema: "internal",
        version: 1,
        services: {
          bad: {
            displayName: "Bad",
            category: "infrastructure-software",
            subcategory: "corporate-app",
            probe: { scheme: "https", host: "app.example.com", port: 443, path: "health" },
          },
        },
      });
      expect(() => new JsonServiceCatalog(catalogPath)).toThrow();
    });

    it("throws on an unsupported version literal", () => {
      writeCatalog({
        $schema: "internal",
        version: 2,
        services: {},
      });
      expect(() => new JsonServiceCatalog(catalogPath)).toThrow();
    });

    it("a valid catalog with multiple probe entries (tcp + https) succeeds", () => {
      // Sanity: the strict validator does not over-reject.
      writeCatalog(VALID_CATALOG);
      expect(() => new JsonServiceCatalog(catalogPath)).not.toThrow();
    });
  });

  describe("port surface (type-level)", () => {
    it("implements the ServiceCatalog port surface (compile-time Pick check)", () => {
      // Compile-time assertion. The runtime side is incidental; the
      // check that matters is that `resolve` and `list` exist.
      writeCatalog(VALID_CATALOG);
      const instance: Pick<JsonServiceCatalog, "resolve" | "list"> =
        new JsonServiceCatalog(catalogPath);
      void instance;
    });
  });
});
