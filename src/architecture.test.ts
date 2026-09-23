import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Enforces the design's "Dependency rule": domain -> shared, redaction
 * only; nothing in `src` imports `tools/`. Extended (not rewritten) as new
 * infrastructure paths appear in later phases (see task 3.7). Walks the
 * filesystem with plain `node:fs` rather than adding a glob dependency the
 * design's dependency list never calls for.
 */
function listFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

function findDomainFiles(): string[] {
  const all = listFiles("src");
  return all.filter((f) => /(^|\/)domain\//.test(f) && !f.includes("__fixtures__"));
}

/**
 * Matches a real `import ... from "<specifier>"` / `export ... from
 * "<specifier>"` statement (anchored on `import`/`export` at line start),
 * capturing the specifier. Anchoring avoids false positives from ordinary
 * string/template literals elsewhere in a file that happen to contain the
 * substring `from "..."` (e.g. an error message built with `` `... from
 * "${from}" to "${to}"` ``), which the previous unanchored regex matched.
 */
const IMPORT_SPECIFIER_RE = /^(?:import|export)[^;]*?\bfrom\s+["']([^"']+)["']/gm;

function importSpecifiers(content: string): string[] {
  return [...content.matchAll(IMPORT_SPECIFIER_RE)].map((m) => m[1] as string);
}

const FORBIDDEN_DOMAIN_SPECIFIERS = [
  "node:fs",
  "node:child_process",
  "node:net",
];

describe("architecture: domain import rule", () => {
  it("no file under */domain/** imports node:fs, node:child_process, node:net, or infrastructure", () => {
    const files = findDomainFiles();
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const specifiers = importSpecifiers(readFileSync(file, "utf8"));
      for (const specifier of specifiers) {
        const isForbidden =
          FORBIDDEN_DOMAIN_SPECIFIERS.includes(specifier) ||
          specifier.includes("/infrastructure/") ||
          specifier.endsWith("/infrastructure");
        if (isForbidden) {
          offenders.push(`${file} imports "${specifier}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("architecture: generator isolation", () => {
  it("no file under src/ imports from tools/", () => {
    const files = listFiles("src");
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const specifiers = importSpecifiers(readFileSync(file, "utf8"));
      for (const specifier of specifiers) {
        if (specifier.includes("/tools/") || specifier.startsWith("tools/")) {
          offenders.push(`${file} imports "${specifier}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** Matches any specifier that resolves under a `ports/` folder. */
function isPortsSpecifier(specifier: string): boolean {
  return /(^|\/)ports\//.test(specifier) || specifier.endsWith("/ports");
}

describe("architecture: domain does not import ports", () => {
  it("no file under */domain/** imports from a ports/ path (domain purity: ports are wired by application/infrastructure, not domain)", () => {
    const files = findDomainFiles();
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const specifiers = importSpecifiers(readFileSync(file, "utf8"));
      for (const specifier of specifiers) {
        if (isPortsSpecifier(specifier)) {
          offenders.push(`${file} imports "${specifier}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

function findKernelFiles(): string[] {
  return listFiles("src").filter((f) => /(^|\/)shared\/kernel\//.test(f));
}

describe("architecture: shared/kernel has no dependencies", () => {
  it("no file under shared/kernel/** imports from shared/domain or shared/ports (kernel is generic technical machinery with zero project dependencies)", () => {
    const files = findKernelFiles();
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const specifiers = importSpecifiers(readFileSync(file, "utf8"));
      for (const specifier of specifiers) {
        const isSharedDomain =
          specifier.includes("/shared/domain/") || specifier.endsWith("/shared/domain");
        const isSharedPorts =
          specifier.includes("/shared/ports/") || specifier.endsWith("/shared/ports");
        if (isSharedDomain || isSharedPorts) {
          offenders.push(`${file} imports "${specifier}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * ADR 0011: zod is the only third-party (non-relative) import domain code
 * may use — its schemas encode business invariants, so it is treated as
 * part of the domain's vocabulary rather than an infrastructure dependency.
 */
const ALLOWED_DOMAIN_THIRD_PARTY_SPECIFIERS = ["zod"];

describe("architecture: domain third-party import allowlist (ADR 0011)", () => {
  it("domain files import only relative paths or the allowlisted third-party packages", () => {
    const files = findDomainFiles();
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const specifiers = importSpecifiers(readFileSync(file, "utf8"));
      for (const specifier of specifiers) {
        const isRelative = specifier.startsWith(".");
        const isAllowedThirdParty = ALLOWED_DOMAIN_THIRD_PARTY_SPECIFIERS.includes(specifier);
        if (!isRelative && !isAllowedThirdParty) {
          offenders.push(`${file} imports "${specifier}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
