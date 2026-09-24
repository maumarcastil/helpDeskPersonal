import { describe, expect, it } from "vitest";
import { SystemClock } from "./system-clock.js";

describe("SystemClock", () => {
  it("returns a Date within a small tolerance of Date.now()", () => {
    const beforeMs = Date.now();
    const clock = new SystemClock();
    const result = clock.now();
    const afterMs = Date.now();

    expect(result).toBeInstanceOf(Date);
    const observed = result.getTime();
    // The clock read sits between the two real-world timestamps; the
    // tolerance is intentionally loose so a slow CI runner cannot flake.
    expect(observed).toBeGreaterThanOrEqual(beforeMs);
    expect(observed).toBeLessThanOrEqual(afterMs + 100);
    expect(Math.abs(observed - Date.now())).toBeLessThan(100);
  });

  it("returns a fresh Date on every call (no shared mutation)", async () => {
    const clock = new SystemClock();
    const first = clock.now();
    // Force the clock forward so the second read cannot return the same
    // millisecond accidentally (Date.now() granularity).
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = clock.now();
    expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());
    expect(second).not.toBe(first);
  });
});
