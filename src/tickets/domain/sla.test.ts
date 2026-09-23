import { describe, expect, it } from "vitest";
import { addBusinessDays, computeSla } from "./sla.js";

describe("computeSla", () => {
  it("P1: 1 hour response / 4 hours resolution", () => {
    const sla = computeSla("P1");
    expect(sla.response).toEqual({ amount: 1, unit: "hour" });
    expect(sla.resolution).toEqual({ amount: 4, unit: "hour" });
  });

  it("P2: 4 hours response / 1 business day resolution", () => {
    const sla = computeSla("P2");
    expect(sla.response).toEqual({ amount: 4, unit: "hour" });
    expect(sla.resolution).toEqual({ amount: 1, unit: "business-day" });
  });

  it("P3: 1 business day response / 3 business days resolution", () => {
    const sla = computeSla("P3");
    expect(sla.response).toEqual({ amount: 1, unit: "business-day" });
    expect(sla.resolution).toEqual({ amount: 3, unit: "business-day" });
  });
});

describe("addBusinessDays", () => {
  it("skips a weekend entirely within the range (Tue + 5 business days)", () => {
    // Tuesday 2026-01-06 UTC + 5 business days:
    // Wed, Thu, Fri, (skip Sat/Sun), Mon, Tue -> 2026-01-13
    const start = new Date("2026-01-06T09:00:00.000Z");
    const result = addBusinessDays(start, 5);
    expect(result.toISOString()).toBe("2026-01-13T09:00:00.000Z");
  });

  it("Friday + 1 business day lands on Monday", () => {
    const friday = new Date("2026-01-09T12:00:00.000Z");
    const result = addBusinessDays(friday, 1);
    expect(result.toISOString()).toBe("2026-01-12T12:00:00.000Z");
  });

  it("Saturday + 1 business day lands on Monday", () => {
    const saturday = new Date("2026-01-10T12:00:00.000Z");
    const result = addBusinessDays(saturday, 1);
    expect(result.toISOString()).toBe("2026-01-12T12:00:00.000Z");
  });
});
