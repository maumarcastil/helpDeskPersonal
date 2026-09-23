import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HmacPseudonymizer } from "./hmac-pseudonymizer.js";

describe("HmacPseudonymizer", () => {
  it("is deterministic: same key + raw value always produces the same ref and display", () => {
    const pseudonymizer = new HmacPseudonymizer("key-a");
    const first = pseudonymizer.pseudonymize("jane.doe@example.com");
    const second = pseudonymizer.pseudonymize("jane.doe@example.com");
    expect(second).toEqual(first);
  });

  it("is key-sensitive: a different key produces a different ref for the same raw value", () => {
    const withKeyA = new HmacPseudonymizer("key-a").pseudonymize("jane.doe@example.com");
    const withKeyB = new HmacPseudonymizer("key-b").pseudonymize("jane.doe@example.com");
    expect(withKeyA.ref).not.toBe(withKeyB.ref);
  });

  it("produces a different ref for a different raw value under the same key", () => {
    const pseudonymizer = new HmacPseudonymizer("key-a");
    const first = pseudonymizer.pseudonymize("jane.doe@example.com");
    const second = pseudonymizer.pseudonymize("john.smith@example.com");
    expect(first.ref).not.toBe(second.ref);
  });

  it("ref follows the usr_<16 hex> shape", () => {
    const { ref } = new HmacPseudonymizer("key-a").pseudonymize("jane.doe@example.com");
    expect(ref).toMatch(/^usr_[0-9a-f]{16}$/);
  });

  it("display is a masked handle, never the raw value", () => {
    const { display } = new HmacPseudonymizer("key-a").pseudonymize("jane.doe@example.com");
    expect(display).not.toBe("jane.doe@example.com");
    expect(display).not.toContain("jane.doe@example.com");
  });

  it("never leaks the raw value into ref or display for a raw value that looks like the digest", () => {
    const raw = "0123456789abcdef";
    const { ref, display } = new HmacPseudonymizer("key-a").pseudonymize(raw);
    expect(ref).not.toBe(`usr_${raw}`);
    expect(display).not.toContain(raw);
  });

  it("matches a known HMAC-SHA256 test vector, truncated to 16 hex chars", () => {
    // HMAC-SHA256(key="key-a", msg="jane.doe@example.com"), first 16 hex
    // chars of the digest, computed independently via node:crypto.
    const expectedDigest16 = createHmac("sha256", "key-a")
      .update("jane.doe@example.com", "utf8")
      .digest("hex")
      .slice(0, 16);
    const { ref } = new HmacPseudonymizer("key-a").pseudonymize("jane.doe@example.com");
    expect(ref).toBe(`usr_${expectedDigest16}`);
  });
});
