import { describe, expect, it } from "vitest";
import { computePriority } from "./priority.js";

describe("computePriority", () => {
  const matrix: ReadonlyArray<
    readonly ["high" | "medium" | "low", "high" | "medium" | "low", "P1" | "P2" | "P3"]
  > = [
    ["high", "high", "P1"],
    ["high", "medium", "P1"],
    ["high", "low", "P2"],
    ["medium", "high", "P1"],
    ["medium", "medium", "P2"],
    ["medium", "low", "P3"],
    ["low", "high", "P2"],
    ["low", "medium", "P3"],
    ["low", "low", "P3"],
  ];

  it.each(matrix)(
    "severity %s, urgency %s -> %s",
    (severity, urgency, expected) => {
      const result = computePriority(severity, urgency);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(expected);
      }
    },
  );

  it("rejects an invalid severity value without returning a priority", () => {
    const result = computePriority("critical" as never, "high");
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid urgency value without returning a priority", () => {
    const result = computePriority("high", "critical" as never);
    expect(result.ok).toBe(false);
  });
});
