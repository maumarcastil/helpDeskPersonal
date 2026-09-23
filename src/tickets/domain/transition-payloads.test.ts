import { describe, expect, it } from "vitest";
import {
  ClosedPayloadSchema,
  EscalatedPayloadSchema,
  InProgressPayloadSchema,
  PendingUserConfirmationPayloadSchema,
  ReopenedPayloadSchema,
  ResolvedPayloadSchema,
  TriagedPayloadSchema,
} from "./transition-payloads.js";

const validTriaged = {
  category: "infrastructure-software",
  subcategory: "vpn",
  severity: "high",
  urgency: "medium",
  affectedUser: "j.doe",
  impactedService: "vpn-gateway",
  summary: "VPN keeps disconnecting",
};

describe("TriagedPayloadSchema", () => {
  it("accepts a fully valid payload", () => {
    const result = TriagedPayloadSchema.safeParse(validTriaged);
    expect(result.success).toBe(true);
  });

  it("rejects a supplied priority field (override #2)", () => {
    const result = TriagedPayloadSchema.safeParse({
      ...validTriaged,
      priority: "P1",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.message.includes("priority")),
      ).toBe(true);
    }
  });

  it("rejects a subcategory that does not belong to the category", () => {
    const result = TriagedPayloadSchema.safeParse({
      ...validTriaged,
      category: "access-identity",
      subcategory: "vpn",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("subcategory"))).toBe(
        true,
      );
    }
  });

  it("rejects a missing required field, naming it", () => {
    const { impactedService: _omit, ...withoutImpactedService } = validTriaged;
    const result = TriagedPayloadSchema.safeParse(withoutImpactedService);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path.includes("impactedService")),
      ).toBe(true);
    }
  });

  it("rejects a wrong-typed / out-of-enum field", () => {
    const result = TriagedPayloadSchema.safeParse({
      ...validTriaged,
      severity: "critical",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("severity"))).toBe(
        true,
      );
    }
  });
});

describe("InProgressPayloadSchema", () => {
  it("accepts an empty payload (note is optional)", () => {
    expect(InProgressPayloadSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a payload with a short note", () => {
    expect(InProgressPayloadSchema.safeParse({ note: "checked logs" }).success).toBe(
      true,
    );
  });

  it("rejects a note longer than 500 chars", () => {
    const result = InProgressPayloadSchema.safeParse({
      note: "a".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognized field (.strict())", () => {
    const result = InProgressPayloadSchema.safeParse({ unexpected: true });
    expect(result.success).toBe(false);
  });
});

describe("PendingUserConfirmationPayloadSchema", () => {
  const valid = {
    diagnosticEvidence: { runId: "run_123" },
    remediationAction: null,
    timestamp: new Date().toISOString(),
  };

  it("accepts a valid payload with a null remediationAction", () => {
    expect(PendingUserConfirmationPayloadSchema.safeParse(valid).success).toBe(
      true,
    );
  });

  it("accepts a valid payload with a remediationAction id", () => {
    expect(
      PendingUserConfirmationPayloadSchema.safeParse({
        ...valid,
        remediationAction: "vpn-gateway-up",
      }).success,
    ).toBe(true);
  });

  it("rejects a missing diagnosticEvidence, naming it", () => {
    const { diagnosticEvidence: _omit, ...rest } = valid;
    const result = PendingUserConfirmationPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path.includes("diagnosticEvidence")),
      ).toBe(true);
    }
  });

  it("rejects a wrong-typed timestamp", () => {
    const result = PendingUserConfirmationPayloadSchema.safeParse({
      ...valid,
      timestamp: "not-a-date",
    });
    expect(result.success).toBe(false);
  });
});

describe("EscalatedPayloadSchema", () => {
  const valid = {
    escalationReason: "service_unreachable",
    target: "network-team",
  };

  it("accepts a valid payload without note", () => {
    expect(EscalatedPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a valid payload with note", () => {
    expect(
      EscalatedPayloadSchema.safeParse({ ...valid, note: "escalating" }).success,
    ).toBe(true);
  });

  it("rejects a missing escalationReason, naming it", () => {
    const { escalationReason: _omit, ...rest } = valid;
    const result = EscalatedPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path.includes("escalationReason")),
      ).toBe(true);
    }
  });

  it("rejects an out-of-enum target", () => {
    const result = EscalatedPayloadSchema.safeParse({
      ...valid,
      target: "not-a-team",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a client-supplied decisionLogRef (spec-v2 correction)", () => {
    const result = EscalatedPayloadSchema.safeParse({
      ...valid,
      decisionLogRef: "aud_123",
    });
    expect(result.success).toBe(false);
  });
});

describe("ResolvedPayloadSchema", () => {
  const valid = { basis: "user-confirmed", timestamp: new Date().toISOString() };

  it("accepts a valid payload for each basis value", () => {
    for (const basis of ["user-confirmed", "auto-timeout", "human-agent"]) {
      expect(ResolvedPayloadSchema.safeParse({ ...valid, basis }).success).toBe(
        true,
      );
    }
  });

  it("accepts an optional diagnosticEvidence", () => {
    expect(
      ResolvedPayloadSchema.safeParse({
        ...valid,
        diagnosticEvidence: { runId: "run_1" },
      }).success,
    ).toBe(true);
  });

  it("rejects a missing basis, naming it", () => {
    const { basis: _omit, ...rest } = valid;
    const result = ResolvedPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("basis"))).toBe(true);
    }
  });

  it("rejects an out-of-enum basis", () => {
    const result = ResolvedPayloadSchema.safeParse({ ...valid, basis: "magic" });
    expect(result.success).toBe(false);
  });
});

describe("ClosedPayloadSchema", () => {
  const valid = { resolutionSummary: "fixed", confirmationSource: "user" };

  it("accepts a valid payload", () => {
    expect(ClosedPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a missing resolutionSummary, naming it", () => {
    const { resolutionSummary: _omit, ...rest } = valid;
    const result = ClosedPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path.includes("resolutionSummary")),
      ).toBe(true);
    }
  });

  it("rejects an out-of-enum confirmationSource", () => {
    const result = ClosedPayloadSchema.safeParse({
      ...valid,
      confirmationSource: "robot",
    });
    expect(result.success).toBe(false);
  });
});

describe("ReopenedPayloadSchema", () => {
  const valid = { reopenReason: "still broken", originalResolutionRef: "tkt_1" };

  it("accepts a valid payload", () => {
    expect(ReopenedPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a missing reopenReason, naming it", () => {
    const { reopenReason: _omit, ...rest } = valid;
    const result = ReopenedPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("reopenReason"))).toBe(
        true,
      );
    }
  });

  it("rejects a wrong-typed originalResolutionRef", () => {
    const result = ReopenedPayloadSchema.safeParse({
      ...valid,
      originalResolutionRef: 123,
    });
    expect(result.success).toBe(false);
  });
});
