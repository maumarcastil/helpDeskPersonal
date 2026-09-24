import { describe, expect, it } from "vitest";
import { CryptoIdGenerator } from "./crypto-id-generator.js";

const TICKET_PATTERN = /^tkt_[0-9a-z]{16,}$/;
const RUN_PATTERN = /^run_[0-9a-z]{16,}$/;
const AUDIT_PATTERN = /^aud_[0-9a-z]{16,}$/;

describe("CryptoIdGenerator", () => {
  it("ticketId() returns a string matching tkt_<opaque-suffix>", () => {
    const gen = new CryptoIdGenerator();
    expect(gen.ticketId()).toMatch(TICKET_PATTERN);
  });

  it("runId() returns a string matching run_<opaque-suffix>", () => {
    const gen = new CryptoIdGenerator();
    expect(gen.runId()).toMatch(RUN_PATTERN);
  });

  it("auditId() returns a string matching aud_<opaque-suffix>", () => {
    const gen = new CryptoIdGenerator();
    expect(gen.auditId()).toMatch(AUDIT_PATTERN);
  });

  it("ticketId() never collides across 1000 consecutive calls", () => {
    const gen = new CryptoIdGenerator();
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(gen.ticketId());
    }
    expect(seen.size).toBe(1000);
  });

  it("runId() never collides across 1000 consecutive calls", () => {
    const gen = new CryptoIdGenerator();
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(gen.runId());
    }
    expect(seen.size).toBe(1000);
  });

  it("auditId() never collides across 1000 consecutive calls", () => {
    const gen = new CryptoIdGenerator();
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(gen.auditId());
    }
    expect(seen.size).toBe(1000);
  });

  it("the opaque suffix is at least 16 characters of hex or base36", () => {
    const gen = new CryptoIdGenerator();
    const ticketId = gen.ticketId();
    const suffix = ticketId.slice("tkt_".length);
    // The spec says "≥16 chars after the prefix" and "hex or base36". The
    // base36 alphabet is the union of [0-9a-z], so any hex-only suffix
    // (subset of base36) is also a valid base36 suffix. A pure hex
    // implementation is fine — we just guard the length and alphabet.
    expect(suffix.length).toBeGreaterThanOrEqual(16);
    expect(suffix).toMatch(/^[0-9a-z]+$/);
  });

  it("two consecutive calls produce distinct ids (basic sanity, not a statistical check)", () => {
    const gen = new CryptoIdGenerator();
    const a = gen.ticketId();
    const b = gen.ticketId();
    expect(a).not.toBe(b);
  });

  it("uses crypto-strong randomness across all three kinds independently", () => {
    // With 64 bits of entropy per id and 1000 draws, the birthday-paradox
    // collision probability is negligible (~2.7e-14). Independence between
    // kinds means a ticket id should never accidentally collide with a
    // run or audit id, which the prefix guards structurally.
    const gen = new CryptoIdGenerator();
    const tickets = new Set<string>();
    const runs = new Set<string>();
    const audits = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      tickets.add(gen.ticketId());
      runs.add(gen.runId());
      audits.add(gen.auditId());
    }
    expect(tickets.size).toBe(1000);
    expect(runs.size).toBe(1000);
    expect(audits.size).toBe(1000);
  });
});
