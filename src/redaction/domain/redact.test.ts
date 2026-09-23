import { describe, expect, it } from "vitest";
import { FAKE_JWT, NEGATIVE_FIXTURES, POSITIVE_FIXTURES } from "./__fixtures__/secrets.js";
import { redact, redactDeep } from "./redact.js";

describe("redact", () => {
  it.each(POSITIVE_FIXTURES)(
    "redacts $label and removes the literal secret value",
    ({ kind, text, secretValue }) => {
      const { text: redacted, findings } = redact(text);
      expect(redacted).not.toContain(secretValue);
      expect(redacted).toContain(`[REDACTED:${kind}]`);
      expect(findings.some((f) => f.kind === kind && f.count >= 1)).toBe(true);
    },
  );

  it.each(NEGATIVE_FIXTURES)(
    "leaves %s byte-identical (no false-positive redaction)",
    (text) => {
      const { text: redacted, findings } = redact(text);
      expect(redacted).toBe(text);
      expect(findings).toEqual([]);
    },
  );

  it("prefers a more specific pattern over HIGH_ENTROPY on the same substring", () => {
    const { text: redacted, findings } = redact(`token: ${FAKE_JWT}`);
    expect(redacted).toContain("[REDACTED:JWT]");
    expect(redacted).not.toContain("[REDACTED:HIGH_ENTROPY]");
    expect(findings).toEqual([{ kind: "JWT", count: 1 }]);
  });

  it("redacts multiple distinct findings and tallies counts per kind", () => {
    const text = "email a@example.com and email b@example.com, password is Hunter2024!";
    const { findings } = redact(text);
    const emailFinding = findings.find((f) => f.kind === "EMAIL");
    expect(emailFinding?.count).toBe(2);
    const secretFinding = findings.find((f) => f.kind === "SECRET_ASSIGNMENT");
    expect(secretFinding?.count).toBe(1);
  });
});

describe("redactDeep", () => {
  it("walks nested objects and arrays, redacting every string leaf", () => {
    const value = {
      description: "contact me at leak@example.com",
      nested: { notes: ["password is Hunter2024!", "all good"] },
      count: 3,
      ok: true,
      tags: null,
    };
    const result = redactDeep(value);
    expect(result.description).toContain("[REDACTED:EMAIL]");
    expect(result.nested.notes[0]).toContain("[REDACTED:SECRET_ASSIGNMENT]");
    expect(result.nested.notes[1]).toBe("all good");
    expect(result.count).toBe(3);
    expect(result.ok).toBe(true);
    expect(result.tags).toBeNull();
  });
});
