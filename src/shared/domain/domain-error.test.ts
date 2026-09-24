import { describe, expect, it } from "vitest";
import { domainError, type DomainErrorCode } from "./domain-error.js";

const ALL_CODES: readonly DomainErrorCode[] = [
  "VALIDATION_ERROR",
  "TICKET_NOT_FOUND",
  "INVALID_TRANSITION",
  "ACTOR_NOT_PERMITTED",
  "REOPEN_WINDOW_EXPIRED",
  "RESOLUTION_CONDITIONS_NOT_MET",
  "NOT_ALLOWLISTED",
  "DIAGNOSTIC_NOT_FOUND",
  "DIAGNOSTIC_NOT_USABLE",
  "UNKNOWN_SERVICE",
  "CONFLICT",
];

describe("domainError", () => {
  it.each(ALL_CODES)("constructs a DomainError for code %s", (code) => {
    const error = domainError(code, `message for ${code}`);

    expect(error.code).toBe(code);
    expect(error.message).toBe(`message for ${code}`);
    expect(error.details).toBeUndefined();
  });

  it("attaches details when supplied", () => {
    const error = domainError("VALIDATION_ERROR", "bad field", {
      field: "severity",
    });

    expect(error.details).toEqual({ field: "severity" });
  });
});
