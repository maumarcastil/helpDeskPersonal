import { describe, expect, it } from "vitest";
import { substitutePlaceholders } from "./template.js";

describe("substitutePlaceholders", () => {
  it("replaces every {{param}} placeholder using the given replacer", () => {
    const result = substitutePlaceholders("Diagnose ticket {{ticketId}}.", (name) => `<${name}>`);
    expect(result).toBe("Diagnose ticket <ticketId>.");
  });

  it("replaces several distinct placeholders in one template", () => {
    const result = substitutePlaceholders(
      "Escalate {{ticketId}} with reason {{reason}}.",
      (name) => `[${name}]`,
    );
    expect(result).toBe("Escalate [ticketId] with reason [reason].");
  });

  it("replaces a repeated placeholder at every occurrence", () => {
    const result = substitutePlaceholders("{{x}} and {{x}} again", (name) => name.toUpperCase());
    expect(result).toBe("X and X again");
  });

  it("leaves text with no placeholders unchanged", () => {
    const result = substitutePlaceholders("no placeholders here", () => "unused");
    expect(result).toBe("no placeholders here");
  });

  it("calls the replacer with the exact placeholder name, not the surrounding braces", () => {
    const seen: string[] = [];
    substitutePlaceholders("{{description}}", (name) => {
      seen.push(name);
      return name;
    });
    expect(seen).toEqual(["description"]);
  });
});
