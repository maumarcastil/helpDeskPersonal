# 0011. Zod in the domain layer

- Status: Accepted
- Date: 2026-09-23

## Context

The tickets domain expresses per-transition payload validation with zod: `TransitionRule.payload: z.ZodType<P>`, and each target state's schema (`transition-payloads.ts`) encodes the exact required/optional fields, types and cross-field constraints for that transition — e.g. spec `ticket-lifecycle`'s "Required Fields Per Transition" requirement, and the `.strict()` rejection of a client-supplied `priority` on `Triaged`. Hexagonal purity, taken literally, would keep every third-party library out of the domain layer and confine zod to an adapter boundary (e.g. the MCP driving adapter, which is where external input first enters the system).

This refactor (task 1.14) also restructures `src/shared` into `kernel/` (generic technical utilities), `domain/` (domain vocabulary: error codes, branded ids) and `ports/` (`Clock`, `IdGenerator`), and adds an architecture-test guard that domain code may import only relative paths and an explicit third-party allowlist. Zod needs to be on that allowlist or the domain payload schemas cannot exist where they currently live.

## Decision

Zod is accepted as the domain's schema language, and it is the **only** allowed third-party import in domain code (`*/domain/**`). The reasoning: these schemas are not input-parsing plumbing, they **are** the business invariants — "a `Triaged` transition requires `category`, `subcategory`, `severity`, `urgency`, `affectedUser`, `impactedService`, `summary`, and rejects a supplied `priority`" is a domain rule, not a technical concern, regardless of which library expresses it. Keeping that rule colocated with the transition table it gates (`transitions.ts` dispatches on `rule.payload.safeParse(...)`) is more valuable than a purist "zero third-party imports" boundary that would force the same rule to be either duplicated in a hand-written validator plus a zod adapter schema, or pushed out to an adapter that then has to re-derive domain knowledge it should not own.

The architecture test (`src/architecture.test.ts`, "domain third-party import allowlist") enforces this allowlist mechanically: any domain file importing a bare (non-relative) specifier other than `"zod"` fails the guard.

## Alternatives considered

- **Hand-written domain validators, zod only in the MCP adapter** — rejected: every transition rule (required fields, enum values, cross-field refinements like "subcategory must belong to category") would have to be expressed twice — once as a hand-rolled validator in the domain, once as a zod schema at the MCP boundary re-parsing the same shape — with the two definitions drifting out of sync as the ticket lifecycle evolves across later phases.
- **Plain TypeScript types only, no runtime validation in the domain** — rejected: the domain's actual callers are LLM agents issuing MCP tool calls with LLM-produced arguments, not a compiler-checked internal caller. A type-only contract gives no runtime protection against a malformed or hallucinated payload; the spec's "Missing required field is rejected" / "Wrong-typed field is rejected" scenarios require an enforced runtime check, which only a schema library (or hand-written validation, see above) can provide.

## Consequences

**Positive**

- Every payload invariant lives in exactly one place (`transition-payloads.ts`), next to the transition table that enforces it, with no adapter-side duplicate to drift.
- Zod's `.strict()`, refinements and discriminated unions let the exhaustive per-transition rules (required fields, `.strict()` rejection of server-computed fields, `subcategory`-belongs-to-`category`) be expressed and unit-tested directly against the domain, without spinning up an adapter.

**Negative**

- The domain layer is now coupled to zod's major version. Zod is pinned per ADR 0005 (TypeScript strict and tooling); upgrading its major version is a change that touches domain code, not just an adapter, and needs the same care as any other domain-level dependency upgrade.
- The "domain has zero third-party dependencies" hexagonal-purity claim no longer holds literally; it is narrowed to "domain has zero third-party dependencies except the one allowlisted schema library," enforced by the architecture test rather than by the folder boundary alone.
