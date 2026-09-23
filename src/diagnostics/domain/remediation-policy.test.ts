import { describe, expect, it } from "vitest";
import { decideRemediation } from "./remediation-policy.js";

describe("decideRemediation", () => {
  it("returns remediate for an allowlisted access-identity/account-locked/reachable combination", () => {
    const decision = decideRemediation({
      category: "access-identity",
      subcategory: "account-locked",
      probe: "connectivity",
      status: "reachable",
    });
    expect(decision).toEqual({
      kind: "remediate",
      entryId: "access-locked-idp-up",
      action: "simulate-account-unlock",
    });
  });

  it("returns remediate for infrastructure-software/vpn/reachable", () => {
    const decision = decideRemediation({
      category: "infrastructure-software",
      subcategory: "vpn",
      probe: "connectivity",
      status: "reachable",
    });
    expect(decision).toEqual({
      kind: "remediate",
      entryId: "vpn-gateway-up",
      action: "record-service-healthy",
    });
  });

  it("escalates a non-allowlisted category (provisioning-permissions)", () => {
    const decision = decideRemediation({
      category: "provisioning-permissions",
      subcategory: "license",
      probe: "connectivity",
      status: "reachable",
    });
    expect(decision).toEqual({ kind: "escalate", reason: "not_allowlisted" });
  });

  it("escalates a non-allowlisted subcategory (access-identity/mfa)", () => {
    const decision = decideRemediation({
      category: "access-identity",
      subcategory: "mfa",
      probe: "connectivity",
      status: "reachable",
    });
    expect(decision).toEqual({ kind: "escalate", reason: "not_allowlisted" });
  });

  it("escalates access-identity/inactive-account (never allowlisted)", () => {
    const decision = decideRemediation({
      category: "access-identity",
      subcategory: "inactive-account",
      probe: "connectivity",
      status: "reachable",
    });
    expect(decision.kind).toBe("escalate");
  });

  it("never matches a degraded status even for an otherwise-allowlisted pair", () => {
    const decision = decideRemediation({
      category: "access-identity",
      subcategory: "account-locked",
      probe: "connectivity",
      status: "degraded",
    });
    expect(decision).toEqual({ kind: "escalate", reason: "not_allowlisted" });
  });

  it("never matches an unreachable status even for an otherwise-allowlisted pair", () => {
    const decision = decideRemediation({
      category: "infrastructure-software",
      subcategory: "corporate-app",
      probe: "connectivity",
      status: "unreachable",
    });
    expect(decision).toEqual({ kind: "escalate", reason: "not_allowlisted" });
  });
});
