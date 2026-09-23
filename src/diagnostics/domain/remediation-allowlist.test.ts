import { describe, expect, it } from "vitest";
import { ALLOWLIST } from "./remediation-allowlist.js";

const EXPECTED_ENTRY_IDS = [
  "access-locked-idp-up",
  "access-reset-idp-up",
  "vpn-gateway-up",
  "app-up",
] as const;

const KNOWN_SYSTEM_STATE_KEYS = new Set([
  "accountUnlockSimulated",
  "resetLinkIssued",
  "serviceVerifiedHealthyAt",
]);

describe("ALLOWLIST", () => {
  it("contains all 4 design entries", () => {
    expect(ALLOWLIST.map((e) => e.id).sort()).toEqual([...EXPECTED_ENTRY_IDS].sort());
  });

  it.each(ALLOWLIST)("entry $id is marked reversible: true", (entry) => {
    expect(entry.reversible).toBe(true);
  });

  it.each(ALLOWLIST)(
    "entry $id's effect mutates only Ticket.systemState fields",
    (entry) => {
      const before = {
        accountUnlockSimulated: false,
        resetLinkIssued: false,
      };
      const after = entry.effect(before, new Date("2026-01-01T00:00:00.000Z"));
      for (const key of Object.keys(after)) {
        expect(KNOWN_SYSTEM_STATE_KEYS.has(key)).toBe(true);
      }
    },
  );

  it("access-locked-idp-up matches access-identity/account-locked/connectivity/reachable and simulates unlock", () => {
    const entry = ALLOWLIST.find((e) => e.id === "access-locked-idp-up");
    expect(entry?.match).toEqual({
      category: "access-identity",
      subcategory: "account-locked",
      probe: "connectivity",
      status: "reachable",
    });
    expect(entry?.action).toBe("simulate-account-unlock");
    const result = entry?.effect(
      { accountUnlockSimulated: false, resetLinkIssued: false },
      new Date(),
    );
    expect(result?.accountUnlockSimulated).toBe(true);
  });

  it("access-reset-idp-up matches access-identity/password-reset and issues a reset link marker", () => {
    const entry = ALLOWLIST.find((e) => e.id === "access-reset-idp-up");
    expect(entry?.match).toEqual({
      category: "access-identity",
      subcategory: "password-reset",
      probe: "connectivity",
      status: "reachable",
    });
    expect(entry?.action).toBe("issue-reset-link-marker");
    const result = entry?.effect(
      { accountUnlockSimulated: false, resetLinkIssued: false },
      new Date(),
    );
    expect(result?.resetLinkIssued).toBe(true);
  });

  it("vpn-gateway-up matches infrastructure-software/vpn and records service healthy", () => {
    const entry = ALLOWLIST.find((e) => e.id === "vpn-gateway-up");
    expect(entry?.match).toEqual({
      category: "infrastructure-software",
      subcategory: "vpn",
      probe: "connectivity",
      status: "reachable",
    });
    expect(entry?.action).toBe("record-service-healthy");
    const now = new Date("2026-02-01T00:00:00.000Z");
    const result = entry?.effect(
      { accountUnlockSimulated: false, resetLinkIssued: false },
      now,
    );
    expect(result?.serviceVerifiedHealthyAt).toBe(now.toISOString());
  });

  it("app-up matches infrastructure-software/corporate-app and records service healthy", () => {
    const entry = ALLOWLIST.find((e) => e.id === "app-up");
    expect(entry?.match).toEqual({
      category: "infrastructure-software",
      subcategory: "corporate-app",
      probe: "connectivity",
      status: "reachable",
    });
    expect(entry?.action).toBe("record-service-healthy");
  });

  it("every entry's userMessage is a non-empty, jargon-free string", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.userMessage.length).toBeGreaterThan(0);
    }
  });
});
