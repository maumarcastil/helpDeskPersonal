import { describe, expect, it } from "vitest";
import { assertValidated } from "../validate.js";
import { MODEL } from "../definitions/index.js";
import { claudeCodeRenderer } from "./claude-code-renderer.js";
import { opencodeRenderer } from "./opencode-renderer.js";
import { vscodeRenderer } from "./vscode-renderer.js";
import type { PlatformRenderer, RenderedFile, ValidatedModel } from "./platform-renderer.js";

/**
 * Golden tests (task 6.10) rendering the real shared definitions, using
 * vitest's built-in `toMatchSnapshot()` rather than a hand-rolled
 * file-comparison harness or `toMatchFileSnapshot()`: it needs no new
 * dependency, the `.snap` files it writes under `__snapshots__/` are plain,
 * git-diffable text (a definitions change shows up as an ordinary reviewable
 * diff), and `vitest -u` is the same update workflow already used for the
 * rest of this codebase's tests. Each test snapshots every `RenderedFile`
 * (path + full contents) for one platform in one block, sorted by path, so
 * a snapshot diff always shows the complete generated tree for that
 * platform rather than one file's diff scattered across many separate
 * snapshot entries.
 */

function validated(): ValidatedModel {
  return assertValidated(MODEL);
}

function renderSorted(renderer: PlatformRenderer): readonly RenderedFile[] {
  return [...renderer.render(validated())].sort((a, b) => a.path.localeCompare(b.path));
}

function asGoldenText(files: readonly RenderedFile[]): string {
  return files
    .map((file) => `===== ${file.path} =====\n${file.contents}`)
    .join("\n");
}

describe("golden: vscodeRenderer output for the real definitions", () => {
  it("matches the committed snapshot", () => {
    expect(asGoldenText(renderSorted(vscodeRenderer))).toMatchSnapshot();
  });
});

describe("golden: claudeCodeRenderer output for the real definitions", () => {
  it("matches the committed snapshot", () => {
    expect(asGoldenText(renderSorted(claudeCodeRenderer))).toMatchSnapshot();
  });
});

describe("golden: opencodeRenderer output for the real definitions", () => {
  it("matches the committed snapshot", () => {
    expect(asGoldenText(renderSorted(opencodeRenderer))).toMatchSnapshot();
  });
});
