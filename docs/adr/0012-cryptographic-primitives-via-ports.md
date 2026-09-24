# 0012. Cryptographic primitives via ports

- Status: Accepted
- Date: 2026-09-23

## Context

Phase 2's first pass hand-rolled two cryptographic primitives directly inside `*/domain/**` files: a plain-TypeScript SHA-256 implementation in `src/audit/domain/hash-chain.ts` (for the audit hash chain's tamper evidence) and a pure-JS 64-bit FNV-1a hash in `src/redaction/domain/pseudonymize.ts` (standing in for the HMAC that ADR 0008 actually specifies). Both were justified at the time as the only way to satisfy ADR 0011's domain third-party import allowlist (`zod` only, no Node builtins) while still needing a digest.

That reasoning traded one architectural rule (domain purity) for a much worse one: unaudited, hand-written cryptography shipped in the domain layer. FNV-1a is not a keyed MAC — it gives determinism and key-sensitivity but no cryptographic guarantee, which ADR 0008 requires for pseudonymization. The hand-written SHA-256, even though verified against FIPS 180-4 test vectors, is exactly the kind of code a reviewer has to re-derive correctness for from scratch, and the codebase now carries a full block-cipher-adjacent implementation with no compiler or ecosystem backing it. Both were caught and reverted in review before merge.

## Decision

Domain code that needs a cryptographic primitive, randomness, wall-clock time, or I/O depends on a **port**, implemented in infrastructure using vetted platform primitives (`node:crypto`). The domain layer never reimplements a cryptographic algorithm, no matter how well-tested the hand-written version is.

- **Pseudonymization** uses HMAC-SHA256 via the `Pseudonymizer` port (`src/redaction/ports/pseudonymizer.ts`: `pseudonymize(raw: string): Pseudonym`), implemented by `HmacPseudonymizer` (`src/redaction/infrastructure/hmac-pseudonymizer.ts`, `node:crypto`'s `createHmac('sha256', key)`, truncated to 16 hex chars). This reaffirms ADR 0008's original "HMAC-SHA256 with a server-side key" decision, which the FNV-1a implementation had quietly weakened. The domain (`redaction/domain/pseudonymize.ts`) keeps only the `Pseudonym` type and the `usr_<16 hex>` ref format rule — no key, no digest algorithm.
- **The audit hash chain** uses SHA-256 via the `Hasher` port (`src/audit/ports/hasher.ts`: `sha256Hex(input: string): string`), implemented by `NodeSha256Hasher` (`src/audit/infrastructure/node-sha256-hasher.ts`, `node:crypto`'s `createHash('sha256')`). `src/audit/domain/hash-chain.ts` keeps the canonical-JSON serialization and chain linking/verification logic, taking a plain `(input: string) => string` hashing function as a parameter rather than importing the `Hasher` type itself — this keeps the domain file decoupled from the port's location while still being satisfied by it, and avoids the domain importing from any `ports/` path (a separate, pre-existing architecture guard).
- **Enforcement**: `src/architecture.test.ts` confines `node:crypto` to each capability's own `infrastructure/**` (`src/redaction/infrastructure/`, `src/audit/infrastructure/`; no domain file, and no file anywhere else in `src`, may import it directly), on top of ADR 0011's existing domain third-party allowlist. ADR 0013 later generalizes this confinement mechanism to per-capability `infrastructure/` folders and to further Node builtins beyond `node:crypto`; the "crypto lives behind a port, never in the domain" decision made here is unchanged.

## Alternatives considered

- **Keep hand-written algorithms in the domain, just review them more carefully** — rejected: this already happened once (the FNV-1a/hand-written-SHA-256 pass) and was caught in review, not by any structural guard. Relying on reviewer vigilance to catch unaudited crypto in every future domain change is not a control; the compiler and the architecture test are.
- **Allow `node:crypto` as a second domain third-party import allowlist entry (alongside `zod`)** — rejected: this breaks ADR 0011's domain-purity boundary (which exists precisely so domain files stay pure functions of their explicit inputs, testable without any platform dependency) and makes domain unit tests non-deterministic-by-construction risk (a domain test could accidentally depend on real HMAC/SHA output rather than an injected fake), undermining the same testability ADR 0011 was written to protect.

## Consequences

**Positive**

- No hand-written cryptographic algorithm exists anywhere in the codebase; every digest/MAC is `node:crypto`, audited and maintained by the platform.
- Domain chain logic (`hash-chain.ts`) and pseudonym format rules (`pseudonymize.ts`) stay pure and unit-testable with a deterministic fake hash function, with the real `node:crypto`-backed adapter exercised separately (and, for the hash chain, also injected into at least one domain-level tamper-detection test) against known test vectors.
- The `node:crypto`-confinement guard makes a future regression (someone reaching for `createHash`/`createHmac` directly in an application or domain file instead of using the port) fail `npm test` immediately, not just at review time.

**Negative**

- One more indirection layer (port + adapter) for what is, at the call site, a single function call — acceptable given this is exactly the boundary ADR 0004 (hexagonal architecture) already draws for every other technical concern (persistence, process execution, network I/O).
- `Hasher`/`Pseudonymizer` must be wired through the composition root and every use case's ports the same way `Clock`/`IdGenerator` already are; a caller that forgets to inject one gets a compile error (the port is a required field), not a silent fallback.
