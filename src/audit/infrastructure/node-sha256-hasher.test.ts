import { describe, expect, it } from "vitest";
import { NodeSha256Hasher } from "./node-sha256-hasher.js";

describe("NodeSha256Hasher", () => {
  it("matches the known SHA-256 test vector for the empty string", () => {
    const hasher = new NodeSha256Hasher();
    expect(hasher.sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches the known SHA-256 test vector for 'abc'", () => {
    const hasher = new NodeSha256Hasher();
    expect(hasher.sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("returns a lowercase 64-char hex digest", () => {
    const hasher = new NodeSha256Hasher();
    const digest = hasher.sha256Hex("some audit entry payload");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", () => {
    const hasher = new NodeSha256Hasher();
    expect(hasher.sha256Hex("same input")).toBe(hasher.sha256Hex("same input"));
  });

  it("produces a different digest for a different input", () => {
    const hasher = new NodeSha256Hasher();
    expect(hasher.sha256Hex("input a")).not.toBe(hasher.sha256Hex("input b"));
  });
});
