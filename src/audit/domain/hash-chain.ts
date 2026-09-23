/**
 * Tamper-evident hash chain for the audit log (spec `audit-decision-log`
 * -> "Audit Hash Chain (Tamper Evidence)"): `hash = sha256(prevHash +
 * canonicalJson(entry))`, each entry's `prevHash` equal to the previous
 * entry's `hash`, first entry's `prevHash` a fixed genesis value.
 *
 * SHA-256 itself is injected as a plain hash function (`Sha256HexFn`,
 * satisfied by the `Hasher` port's `sha256Hex` method, implemented in
 * infrastructure via `node:crypto`; ADR 0012) rather than implemented or
 * imported here: this file lives under a domain folder, and the
 * architecture guard (ADR 0011) restricts domain third-party imports to
 * `zod` only and forbids importing any `ports/` path — even a type-only
 * one. Typing the parameter as a plain function keeps this file decoupled
 * from the `Hasher` interface's location while still being trivially
 * satisfied by it. This module keeps only the canonical JSON serialization
 * and the chain linking/verification logic.
 */

/** A hex-encoding SHA-256 function, e.g. `Hasher.sha256Hex` bound to an instance. */
export type Sha256HexFn = (input: string) => string;

/** Fixed prevHash for the first entry in a chain. */
export const GENESIS_HASH = "0".repeat(64);

/** Deterministic JSON serialization: object keys sorted, no whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

export interface ChainableEntry {
  readonly seq: number;
}

export function computeHash(
  sha256Hex: Sha256HexFn,
  prevHash: string,
  entryWithoutHash: ChainableEntry,
): string {
  return sha256Hex(
    canonicalJson({ ...(entryWithoutHash as unknown as Record<string, unknown>), prevHash }),
  );
}

export type Chained<T> = T & { readonly prevHash: string; readonly hash: string };

/** Computes `prevHash`/`hash` for every entry, in array order (`entries[0]` chains to `GENESIS_HASH`). */
export function buildChain<T extends ChainableEntry>(
  sha256Hex: Sha256HexFn,
  entries: readonly T[],
): ReadonlyArray<Chained<T>> {
  let prevHash = GENESIS_HASH;
  const result: Chained<T>[] = [];
  for (const entry of entries) {
    const hash = computeHash(sha256Hex, prevHash, entry);
    result.push({ ...entry, prevHash, hash });
    prevHash = hash;
  }
  return result;
}

export type ChainVerification =
  | { readonly valid: true }
  | { readonly valid: false; readonly brokenAtSeq: number };

/**
 * Recomputes every hash from scratch and compares against the stored
 * `prevHash`/`hash`, detecting a break introduced by editing any prior
 * entry's content, `prevHash`, or `hash` outside the append-only API.
 */
export function verifyChain<T extends ChainableEntry>(
  sha256Hex: Sha256HexFn,
  entries: readonly Chained<T>[],
): ChainVerification {
  let expectedPrevHash = GENESIS_HASH;
  for (const entry of entries) {
    if (entry.prevHash !== expectedPrevHash) {
      return { valid: false, brokenAtSeq: entry.seq };
    }
    const { hash, prevHash: _prevHash, ...content } = entry;
    const recomputed = computeHash(sha256Hex, expectedPrevHash, content as unknown as T);
    if (recomputed !== hash) {
      return { valid: false, brokenAtSeq: entry.seq };
    }
    expectedPrevHash = hash;
  }
  return { valid: true };
}
