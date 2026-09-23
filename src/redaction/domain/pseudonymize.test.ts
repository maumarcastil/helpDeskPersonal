import { describe, expect, it } from "vitest";
import { isValidPseudonymRef } from "./pseudonymize.js";

describe("isValidPseudonymRef", () => {
  it("accepts the usr_<16 hex> shape", () => {
    expect(isValidPseudonymRef("usr_0123456789abcdef")).toBe(true);
  });

  it("rejects a ref missing the usr_ prefix", () => {
    expect(isValidPseudonymRef("0123456789abcdef")).toBe(false);
  });

  it("rejects a ref with fewer than 16 hex chars", () => {
    expect(isValidPseudonymRef("usr_0123")).toBe(false);
  });

  it("rejects a ref with more than 16 hex chars", () => {
    expect(isValidPseudonymRef("usr_0123456789abcdef00")).toBe(false);
  });

  it("rejects a ref with uppercase hex chars", () => {
    expect(isValidPseudonymRef("usr_0123456789ABCDEF")).toBe(false);
  });
});
