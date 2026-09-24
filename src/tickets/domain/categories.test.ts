import { describe, expect, it } from "vitest";
import {
  CATEGORY_SUBCATEGORIES,
  isSubcategoryOfCategory,
  type Category,
  type Subcategory,
} from "./categories.js";

describe("CATEGORY_SUBCATEGORIES", () => {
  it("maps access-identity to its 4 subcategories", () => {
    expect(CATEGORY_SUBCATEGORIES["access-identity"]).toEqual([
      "account-locked",
      "password-reset",
      "mfa",
      "inactive-account",
    ]);
  });

  it("maps infrastructure-software to its 3 subcategories", () => {
    expect(CATEGORY_SUBCATEGORIES["infrastructure-software"]).toEqual([
      "vpn",
      "performance",
      "corporate-app",
    ]);
  });

  it("maps provisioning-permissions to its 3 subcategories", () => {
    expect(CATEGORY_SUBCATEGORIES["provisioning-permissions"]).toEqual([
      "folder-repo-access",
      "license",
      "profile-change",
    ]);
  });

  it("every subcategory belongs to exactly one category", () => {
    const seen = new Map<Subcategory, Category>();
    for (const [category, subcategories] of Object.entries(
      CATEGORY_SUBCATEGORIES,
    ) as Array<[Category, readonly Subcategory[]]>) {
      for (const subcategory of subcategories) {
        expect(seen.has(subcategory)).toBe(false);
        seen.set(subcategory, category);
      }
    }
  });
});

describe("isSubcategoryOfCategory", () => {
  it("returns true for a matching pair", () => {
    expect(isSubcategoryOfCategory("infrastructure-software", "vpn")).toBe(
      true,
    );
  });

  it("returns false for a mismatched pair", () => {
    expect(isSubcategoryOfCategory("access-identity", "vpn")).toBe(false);
  });
});
