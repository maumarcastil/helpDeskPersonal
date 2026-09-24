import type { Category, Subcategory } from "../../tickets/domain/categories.js";
import type { Ticket } from "../../tickets/domain/ticket.js";
import type { ProbeStatus } from "./diagnostic-report.js";

/**
 * Every action an allowlist entry may take (design "Remediation
 * allowlist"). Each one mutates only this system's own simulated state —
 * never a real external credential, identity, or infrastructure system
 * (spec `remediation-policy` -> "Typed Remediation Allowlist").
 */
export type RemediationAction =
  | "simulate-account-unlock"
  | "issue-reset-link-marker"
  | "record-service-healthy";

export interface AllowlistEntry {
  readonly id: string;
  readonly match: {
    readonly category: Category;
    readonly subcategory: Subcategory;
    readonly probe: "connectivity";
    readonly status: ProbeStatus;
  };
  readonly action: RemediationAction;
  /** Literal `true`: a non-reversible entry does not type-check. */
  readonly reversible: true;
  /** Mutates only `Ticket['systemState']`, never any other ticket field. */
  readonly effect: (state: Ticket["systemState"], now: Date) => Ticket["systemState"];
  readonly userMessage: string;
}

export const ALLOWLIST: readonly AllowlistEntry[] = [
  {
    id: "access-locked-idp-up",
    match: {
      category: "access-identity",
      subcategory: "account-locked",
      probe: "connectivity",
      status: "reachable",
    },
    action: "simulate-account-unlock",
    reversible: true,
    effect: (state) => ({ ...state, accountUnlockSimulated: true }),
    userMessage:
      "Your account lock has been simulated-unlocked. Please try signing in again.",
  },
  {
    id: "access-reset-idp-up",
    match: {
      category: "access-identity",
      subcategory: "password-reset",
      probe: "connectivity",
      status: "reachable",
    },
    action: "issue-reset-link-marker",
    reversible: true,
    effect: (state) => ({ ...state, resetLinkIssued: true }),
    userMessage: "A password reset link has been issued. Please check your email.",
  },
  {
    id: "vpn-gateway-up",
    match: {
      category: "infrastructure-software",
      subcategory: "vpn",
      probe: "connectivity",
      status: "reachable",
    },
    action: "record-service-healthy",
    reversible: true,
    effect: (state, now) => ({ ...state, serviceVerifiedHealthyAt: now.toISOString() }),
    userMessage: "The VPN gateway is reachable again. Please retry your connection.",
  },
  {
    id: "app-up",
    match: {
      category: "infrastructure-software",
      subcategory: "corporate-app",
      probe: "connectivity",
      status: "reachable",
    },
    action: "record-service-healthy",
    reversible: true,
    effect: (state, now) => ({ ...state, serviceVerifiedHealthyAt: now.toISOString() }),
    userMessage: "The application is reachable again. Please retry.",
  },
];
