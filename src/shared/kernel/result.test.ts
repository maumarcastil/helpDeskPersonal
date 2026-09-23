import { describe, expect, it } from "vitest";
import { err, ok } from "./result.js";

describe("Result", () => {
  it("ok(value) constructs a success result that narrows on .ok", () => {
    const result = ok(42);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    } else {
      throw new Error("expected result.ok to be true");
    }
  });

  it("err(error) constructs a failure result that narrows on .ok", () => {
    const result = err({ code: "VALIDATION_ERROR", message: "bad input" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "VALIDATION_ERROR",
        message: "bad input",
      });
    } else {
      throw new Error("expected result.ok to be false");
    }
  });
});
