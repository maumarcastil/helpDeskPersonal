/**
 * Port for computing a hex-encoded SHA-256 digest (design "Audit Hash
 * Chain (Tamper Evidence)"; ADR 0012). Implemented by `NodeSha256Hasher`
 * (infrastructure, `node:crypto`'s `createHash('sha256')`). The domain's
 * chain functions (`hash-chain.ts`) never import this interface directly
 * — they take a plain `(input: string) => string` function so the domain
 * stays decoupled from where the port lives, while `Hasher.sha256Hex`
 * trivially satisfies that shape.
 */
export interface Hasher {
  sha256Hex(input: string): string;
}
