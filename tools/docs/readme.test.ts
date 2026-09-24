import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Cheap honesty check for the root `README.md`: every repo-relative path
 * and `npm run <script>` it documents must actually exist, so the reviewer
 * onboarding doc cannot silently drift from the repository it describes.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const README_PATH = join(REPO_ROOT, "README.md");

function readReadme(): string {
  return readFileSync(README_PATH, "utf8");
}

interface PackageJson {
  readonly engines: { readonly node: string };
  readonly scripts: Readonly<Record<string, string>>;
}

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as PackageJson;
}

/** Backticked repo-relative paths: a known top-level directory prefix, a
 *  dot-directory (`.claude/...`), or a known root config/doc file. `data/`
 *  is deliberately not a prefix: it is gitignored runtime state created by
 *  the server on first write, so it is absent on a clean checkout and in CI. */
const PATH_TOKEN =
  /`((?:src|scripts|config|docs|tools)\/[\w./-]*|\.(?:claude|github|opencode|vscode)\/[\w./-]*|package\.json|AGENTS\.md|CLAUDE\.md|README\.md|\.mcp\.json|opencode\.json|tsconfig(?:\.build)?\.json|vitest\.config\.ts)`/g;

function referencedPaths(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(PATH_TOKEN)].map((m) => m[1] as string))];
}

function referencedNpmScripts(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1] as string))];
}

describe("README.md: exists and stays honest about repo paths and npm scripts", () => {
  it("exists at the repo root", () => {
    expect(() => readReadme()).not.toThrow();
  });

  it("every referenced repo path actually exists", () => {
    const paths = referencedPaths(readReadme());
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const resolved = join(REPO_ROOT, path.replace(/\/$/, ""));
      expect(existsSync(resolved), `README.md references missing path "${path}"`).toBe(true);
    }
  });

  it("every `npm run <script>` it documents exists in package.json", () => {
    const scripts = referencedNpmScripts(readReadme());
    expect(scripts.length).toBeGreaterThan(0);
    const pkg = readPackageJson();
    for (const script of scripts) {
      expect(Object.keys(pkg.scripts), `README.md runs "npm run ${script}"`).toContain(script);
    }
  });

  it("states the same Node engine requirement as package.json", () => {
    const pkg = readPackageJson();
    expect(readReadme()).toContain(pkg.engines.node);
  });
});
