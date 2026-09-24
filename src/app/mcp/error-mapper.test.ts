import { describe, expect, it, vi } from "vitest";
import { domainError, type DomainErrorCode } from "../../shared/domain/domain-error.js";
import { mapDomainError, mapUnexpectedError } from "./error-mapper.js";

const ALL_CODES: DomainErrorCode[] = [
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

describe("mapDomainError", () => {
  it.each(ALL_CODES)("maps %s to the documented error envelope", (code) => {
    const error = domainError(code, `message for ${code}`, { some: "detail" });
    const result = mapDomainError(error);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code, message: `message for ${code}`, details: { some: "detail" } },
    });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(result.structuredContent) },
    ]);
  });

  it("omits details when the domain error carries none", () => {
    const error = domainError("TICKET_NOT_FOUND", "not found");
    const result = mapDomainError(error);
    expect(result.structuredContent).toEqual({
      error: { code: "TICKET_NOT_FOUND", message: "not found" },
    });
  });
});

describe("mapUnexpectedError", () => {
  it("maps an unexpected thrown error to INTERNAL_ERROR without leaking the stack to the client", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const thrown = new Error("boom: something with a stack trace");
      const result = mapUnexpectedError(thrown);

      expect(result.isError).toBe(true);
      expect(result.structuredContent.error.code).toBe("INTERNAL_ERROR");
      expect(result.structuredContent.error.message).not.toContain("boom");
      expect(JSON.stringify(result)).not.toMatch(/at .*\(.*:\d+:\d+\)/);

      expect(stderrSpy).toHaveBeenCalled();
      const loggedText = stderrSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(loggedText).toContain("boom");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("handles a non-Error thrown value without crashing", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = mapUnexpectedError("just a string");
      expect(result.structuredContent.error.code).toBe("INTERNAL_ERROR");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
