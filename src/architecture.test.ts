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

/** Matches `... from "<specifier>"` / `... from '<specifier>'`, capturing the specifier. */
const IMPORT_SPECIFIER_RE = /from\s+["']([^"']+)["']/g;

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
