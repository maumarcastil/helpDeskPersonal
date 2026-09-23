import { describe, expect, it } from "vitest";
import { NodeSha256Hasher } from "../infrastructure/node-sha256-hasher.js";
import { buildChain, GENESIS_HASH, verifyChain } from "./hash-chain.js";

interface Fixture {
  readonly seq: number;
  readonly message: string;
}

/** Deterministic fake hash function for tests that only exercise chain
 * linking/verification logic, not the real digest algorithm. */
function fakeHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(64, "0");
}

describe("buildChain (fake hash function)", () => {
  it("produces monotonically increasing seq and a hash for every entry", () => {
    const entries: Fixture[] = [
      { seq: 1, message: "first" },
      { seq: 2, message: "second" },
      { seq: 3, message: "third" },
    ];
    const chained = buildChain(fakeHash, entries);
    expect(chained.map((e) => e.seq)).toEqual([1, 2, 3]);
    for (const entry of chained) {
      expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("chains each entry's prevHash to the previous entry's hash", () => {
    const entries: Fixture[] = [
      { seq: 1, message: "first" },
      { seq: 2, message: "second" },
    ];
    const [first, second] = buildChain(fakeHash, entries);
    expect(first?.prevHash).toBe(GENESIS_HASH);
    expect(second?.prevHash).toBe(first?.hash);
  });
});

describe("verifyChain (fake hash function)", () => {
  it("passes for an unmodified chain", () => {
    const entries: Fixture[] = [
      { seq: 1, message: "first" },
      { seq: 2, message: "second" },
      { seq: 3, message: "third" },
    ];
    const chained = buildChain(fakeHash, entries);
    expect(verifyChain(fakeHash, chained)).toEqual({ valid: true });
  });

  it("detects tampering with a past entry's content", () => {
    const entries: Fixture[] = [
      { seq: 1, message: "first" },
      { seq: 2, message: "second" },
      { seq: 3, message: "third" },
    ];
    const chained = buildChain(fakeHash, entries);
    const tampered = chained.map((entry, i) =>
      i === 0 ? { ...entry, message: "tampered" } : entry,
    );
    const result = verifyChain(fakeHash, tampered);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.brokenAtSeq).toBe(chained[0]?.seq);
    }
  });

  it("detects tampering with prevHash directly", () => {
    const entries: Fixture[] = [
      { seq: 1, message: "first" },
      { seq: 2, message: "second" },
    ];
    const chained = buildChain(fakeHash, entries);
    const tampered = chained.map((entry, i) =>
      i === 1 ? { ...entry, prevHash: "0".repeat(64) } : entry,
    );
    const result = verifyChain(fakeHash, tampered);
    expect(result.valid).toBe(false);
  });
});

/**
 * At least one tamper-detection round-trip is exercised with the real
 * `NodeSha256Hasher` (node:crypto), not just the deterministic fake, so
 * the chain's actual production hashing path is proven, not only its
 * linking/verification logic.
 */
describe("buildChain / verifyChain (real NodeSha256Hasher)", () => {
  it("builds and verifies a real SHA-256 chain, and detects tampering", () => {
    const hasher = new NodeSha256Hasher();
    const sha256Hex = hasher.sha256Hex.bind(hasher);
    const entries: Fixture[] = [
      { seq: 1, message: "first" },
      { seq: 2, message: "second" },
      { seq: 3, message: "third" },
    ];
    const chained = buildChain(sha256Hex, entries);
    expect(chained.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(chained[0]?.prevHash).toBe(GENESIS_HASH);
    for (const entry of chained) {
      expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(verifyChain(sha256Hex, chained)).toEqual({ valid: true });

    const tampered = chained.map((entry, i) =>
      i === 0 ? { ...entry, message: "tampered" } : entry,
    );
    const result = verifyChain(sha256Hex, tampered);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.brokenAtSeq).toBe(chained[0]?.seq);
    }
  });
});
