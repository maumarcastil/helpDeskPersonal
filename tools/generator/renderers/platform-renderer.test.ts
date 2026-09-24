import { describe, expect, it } from "vitest";
import { MODEL } from "../definitions/index.js";
import { assertNoDuplicatePaths, type RenderedFile, type ValidatedModel } from "./platform-renderer.js";

/**
 * `assertNoDuplicatePaths` (task 6.10b review fix): the guard every
 * `PlatformRenderer` runs on its own output before returning it, so a
 * colliding path (a reserved synthetic id reused by a real definition, or a
 * future renderer bug) fails loudly at render time instead of silently
 * letting one `RenderedFile` overwrite another's contents once the CLI
 * (task 6.11) writes them to disk.
 */
describe("assertNoDuplicatePaths", () => {
  it("does not throw when every path is unique", () => {
    const files: readonly RenderedFile[] = [
      { path: "a.md", contents: "a" },
      { path: "b.md", contents: "b" },
    ];
    expect(() => assertNoDuplicatePaths(files, "testRenderer")).not.toThrow();
  });

  it("throws, naming the renderer and the offending path, when two files share a path", () => {
    const files: readonly RenderedFile[] = [
      { path: "a.md", contents: "first" },
      { path: "b.md", contents: "b" },
      { path: "a.md", contents: "second" },
    ];
    expect(() => assertNoDuplicatePaths(files, "testRenderer")).toThrow(
      /testRenderer.*duplicate.*"a\.md"/,
    );
  });

  it("does not throw for an empty list", () => {
    expect(() => assertNoDuplicatePaths([], "testRenderer")).not.toThrow();
  });
});

/**
 * `ValidatedModel` is nominally branded (task 6.10b review fix): only
 * `assertValidated` (validate.ts) can produce one. This is a compile-time
 * guarantee, not a runtime one, so it is checked by `npm run typecheck`
 * rather than by a runtime assertion: the `@ts-expect-error` below fails
 * `tsc` (as "unused directive") if this object literal ever type-checks
 * without it, which is exactly the regression this test protects against.
 */
describe("ValidatedModel: nominal brand", () => {
  it("cannot be constructed as a plain object literal, only through assertValidated", () => {
    // @ts-expect-error - ValidatedModel is nominally branded; only
    // assertValidated (validate.ts) can produce one, never an ad hoc
    // { model, longestHandoffPath } object literal.
    const attempt: ValidatedModel = { model: MODEL, longestHandoffPath: 0 };
    expect(attempt.longestHandoffPath).toBe(0);
  });
});
