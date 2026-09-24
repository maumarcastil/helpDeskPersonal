import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  "node:crypto",
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

/**
 * Resolves a relative import specifier against the importing file's own
 * directory (POSIX-style; this repo only ever runs on POSIX paths) so the
 * guard can tell "escapes `src/` into the top-level `tools/` generator
 * directory" apart from "is a same-tree directory that happens to be named
 * `tools`" (e.g. `src/app/mcp/tools/`, Phase 4's MCP tool handlers - a
 * false positive the original substring check did not anticipate).
 */
function resolveRelativeSpecifier(fromFile: string, specifier: string): string {
  const segments = [...dirname(fromFile).split("/"), ...specifier.split("/")];
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved.join("/");
}

describe("architecture: generator isolation", () => {
  it("no file under src/ imports from the top-level tools/ generator directory", () => {
    const files = listFiles("src");
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const specifiers = importSpecifiers(readFileSync(file, "utf8"));
      for (const specifier of specifiers) {
        if (!specifier.startsWith(".")) continue; // only a relative specifier can escape src/
        const resolved = resolveRelativeSpecifier(file, specifier);
        if (resolved === "tools" || resolved.startsWith("tools/")) {
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

/**
 * ADR 0013 (amends ADR 0012's mechanism): per-capability infrastructure
 * adapters replaced the single global `src/infrastructure/`, so the
 * confinement path is now `src/<capability>/infrastructure/**` (and,
 * eventually, `src/app/**` for cross-cutting bootstrapping), not a fixed
 * `src/infrastructure/crypto/**` path. Confinement also grows from just
 * `node:crypto` to every Node builtin an adapter will need: an adapter
 * reaching for the filesystem, child processes, or the network is exactly
 * as infrastructure-only as one reaching for crypto.
 */
const CONFINED_NODE_BUILTINS = [
  "node:crypto",
  "node:fs",
  "node:child_process",
  "node:net",
  "node:dns",
  "node:http",
  "node:https",
];

/** True for a path under any capability's `infrastructure/**` or under `src/app/**`. */
function isInfrastructureOrAppPath(file: string): boolean {
  return /(^|\/)infrastructure\//.test(file) || /^src\/app\//.test(file);
}

describe("architecture: infrastructure-only Node builtins are confined to */infrastructure/** or src/app/** (ADR 0013)", () => {
  it("no file outside a capability's infrastructure/** or src/app/** imports node:crypto, node:fs, node:child_process, node:net, node:dns, or node:http(s)", () => {
    const files = listFiles("src").filter((f) => !isInfrastructureOrAppPath(f));
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const specifiers = importSpecifiers(readFileSync(file, "utf8"));
      for (const specifier of specifiers) {
        if (CONFINED_NODE_BUILTINS.includes(specifier)) {
          offenders.push(`${file} imports "${specifier}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * ADR 0013: `domain/` and `application/` never depend on a capability's
 * `infrastructure/` (they depend on `ports/` instead, wired at the
 * composition root), and `src/shared/` — imported by every domain — never
 * imports a capability's `infrastructure/` either, since that would let
 * infrastructure leak into the most-depended-on module in the codebase.
 */
describe("architecture: domain/application/shared never import a capability's infrastructure/ (ADR 0013)", () => {
  it("no file under domain/, application/, or src/shared/** imports an infrastructure/ path", () => {
    const files = listFiles("src").filter(
      (f) => /(^|\/)(domain|application)\//.test(f) || /^src\/shared\//.test(f),
    );
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const specifiers = importSpecifiers(readFileSync(file, "utf8"));
      for (const specifier of specifiers) {
        const isInfrastructure =
          specifier.includes("/infrastructure/") || specifier.endsWith("/infrastructure");
        if (isInfrastructure) {
          offenders.push(`${file} imports "${specifier}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Phase 3 (PR B) extension: the boundary between executable scripts
 * (`scripts/**`) and the rest of the codebase. Two guards:
 *
 *  1. `scripts/**` may NOT reach into a capability's `infrastructure/`
 *     adapter (it'd bypass the runner layer — the script's whole point
 *     is to run as a subprocess so an adversary who tampers with the
 *     catalog or runner cannot also poison the script). The probe
 *     script reads the report schema from `src/diagnostics/domain/`
 *     and shared utilities from `src/shared/`; nothing else.
 *  2. No file under `src/**` may import from `scripts/**`. `scripts/`
 *     is a leaf — it is invoked as a subprocess by the runner, never
 *     imported by library code. A `src/` file that imports a script
 *     would couple library code to a file path that is not part of
 *     the npm package's published surface, which is a portability
 *     time bomb.
 *
 * These rules were extended (not rewritten) in Phase 3 (task 3.7)
 * because tests for the connector scripts did not exist when the
 * architecture guard was first written (ADR 0013 covers only
 * `src/**`).
 */
describe("architecture: scripts/ boundary", () => {
  function listScriptFiles(): string[] {
    return listFiles("scripts");
  }

  it("no file under scripts/** imports a capability's infrastructure/ (scripts bypass the runner layer if they do)", () => {
    const files = listScriptFiles();
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const specifiers = importSpecifiers(readFileSync(file, "utf8"));
      for (const specifier of specifiers) {
        const isCapabilityInfrastructure =
          specifier.includes("/infrastructure/") || specifier.endsWith("/infrastructure");
        // The shared/ ports/ adapters like HmacPseudonymizer live under
        // `src/redaction/infrastructure/` — caught by the rule above.
        // `src/app/system/*` adapters are also reachable from `src/app/`,
        // but scripts must not reach into them either: phase 4's
        // composition root is the only consumer.
        if (isCapabilityInfrastructure || specifier.includes("/app/system/")) {
          offenders.push(`${file} imports "${specifier}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no file under src/** imports from scripts/** (scripts are invoked as subprocesses, never imported by library code)", () => {
    const files = listFiles("src");
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const specifiers = importSpecifiers(readFileSync(file, "utf8"));
      for (const specifier of specifiers) {
        if (specifier.includes("scripts/") || specifier.startsWith("scripts/")) {
          offenders.push(`${file} imports "${specifier}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("scripts/ may import from src/diagnostics/domain/ and src/shared/ (sanity check that the probe contract is wireable)", () => {
    // The connectivity probe reads the DiagnosticReportSchema from
    // src/diagnostics/domain and would reasonably import shared
    // utilities. There is no direct "must import these" assertion —
    // instead, the test confirms at least one script exists that is
    // currently doing so, so the import-resolution path has been
    // exercised. Future regressions that move the schema out of
    // diagnostics/domain will break the probe script's build, not
    // this test.
    const files = listScriptFiles();
    const scriptImportingDomain = files.some((file) => {
      const specifiers = importSpecifiers(readFileSync(file, "utf8"));
      return specifiers.some(
        (specifier) =>
          specifier.includes("/diagnostics/domain/") || specifier.includes("/shared/"),
      );
    });
    expect(scriptImportingDomain).toBe(true);
  });
});

/**
 * Task 6.13 (PR C): extends the "generator isolation" describe block above
 * (which already proves `src/` never imports `tools/`) with the other half
 * of ADR 0004/0009's boundary — `tools/generator/**` may import from `src/`
 * ONLY `src/app/mcp/tool-names`, the single source of truth for the MCP
 * tool names both the server (`server.ts`) and the generator's
 * `capabilities.ts`/`opencode-renderer.ts` read. `tool-names.ts` itself has
 * zero imports (verified by reading it directly), so there is nothing else
 * from `src/` that importing it would transitively pull in. Reuses
 * `listFiles`, `importSpecifiers`, and `resolveRelativeSpecifier` from
 * above rather than redefining them, since all three already take a
 * directory/file argument and have no `src`-specific behavior baked in.
 */
const ALLOWED_TOOLS_SRC_IMPORT = "src/app/mcp/tool-names";

describe("architecture: tools/generator/ imports only src/app/mcp/tool-names from src/ (task 6.13)", () => {
  it("no relative import under tools/generator/ resolves into src/ other than src/app/mcp/tool-names", () => {
    const files = listFiles("tools/generator");
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const specifiers = importSpecifiers(readFileSync(file, "utf8"));
      for (const specifier of specifiers) {
        if (!specifier.startsWith(".")) continue; // only a relative specifier can reach src/
        const resolved = resolveRelativeSpecifier(file, specifier).replace(/\.js$/, "");
        if (resolved === ALLOWED_TOOLS_SRC_IMPORT) continue;
        if (resolved === "src" || resolved.startsWith("src/")) {
          offenders.push(
            `${file} imports "${specifier}" (resolves to "${resolved}"; only "${ALLOWED_TOOLS_SRC_IMPORT}" is allowed)`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("at least one tools/generator/ file actually imports src/app/mcp/tool-names (sanity check the allowlisted import is exercised)", () => {
    const files = listFiles("tools/generator");
    const importsToolNames = files.some((file) => {
      const specifiers = importSpecifiers(readFileSync(file, "utf8"));
      return specifiers.some(
        (specifier) =>
          specifier.startsWith(".") &&
          resolveRelativeSpecifier(file, specifier).replace(/\.js$/, "") === ALLOWED_TOOLS_SRC_IMPORT,
      );
    });
    expect(importsToolNames).toBe(true);
  });
});
