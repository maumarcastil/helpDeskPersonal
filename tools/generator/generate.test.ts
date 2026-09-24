import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentDefinition, GeneratorModel, PromptDefinition } from "./definitions/schema.js";
import { MODEL } from "./definitions/index.js";
import {
  checkRenderedFiles,
  findCrossPlatformDuplicatePaths,
  renderAll,
  runGenerate,
  writeRenderedFiles,
} from "./generate.js";
import type { RenderedFile } from "./renderers/platform-renderer.js";

/**
 * task 6.11/6.12 (PR C): the CLI's testable core. Filesystem-touching
 * behavior (`writeRenderedFiles`, `checkRenderedFiles`, `runGenerate`) is
 * exercised against a real temp directory created with `mkdtemp` under
 * `os.tmpdir()` and removed in `afterEach`, per the task's instruction that
 * the output root be injectable so tests never touch the real repo.
 */

const MCP_SERVER: GeneratorModel["mcpServer"] = {
  name: "helpdesk",
  command: "npx",
  args: ["tsx", "src/app/mcp/main.ts"],
  env: [],
};

function agent(overrides: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: "triage",
    role: "triage",
    description: "d",
    instructions: "i",
    capabilities: ["ticket.create"],
    handoffs: [],
    ...overrides,
  };
}

function prompt(overrides: Partial<PromptDefinition>): PromptDefinition {
  return {
    id: "new-ticket",
    description: "d",
    agent: "triage",
    template: "{{description}}",
    params: [{ name: "description", kind: "free-text" }],
    ...overrides,
  };
}

function model(overrides: Partial<GeneratorModel>): GeneratorModel {
  return {
    agents: [agent({})],
    prompts: [],
    mcpServer: MCP_SERVER,
    ...overrides,
  };
}

function cyclicModel(): GeneratorModel {
  return model({
    agents: [
      agent({ id: "triage", handoffs: ["diagnostic"] }),
      agent({ id: "diagnostic", role: "diagnostic", handoffs: ["triage"] }),
    ],
  });
}

describe("renderAll: pure validate + render over all three platforms", () => {
  it("returns ok:true with a non-empty file list for the real shared definitions", () => {
    const result = renderAll(MODEL);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.files.length).toBeGreaterThan(0);

    const paths = result.files.map((f) => f.path);
    // one file per real platform's MCP config proves all three renderers ran
    expect(paths).toContain(".vscode/mcp.json");
    expect(paths).toContain(".mcp.json");
    expect(paths).toContain("opencode.json");
  });

  it("returns ok:false with every validation error and renders nothing for a cyclic model", () => {
    const result = renderAll(cyclicModel());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.some((e) => e.includes("handoff cycle"))).toBe(true);
  });

  it("returns ok:false for a model that fails schema validation, without throwing", () => {
    const invalid = { agents: [], prompts: [], mcpServer: MCP_SERVER, extra: "not allowed" } as unknown as GeneratorModel;
    const result = renderAll(invalid);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("findCrossPlatformDuplicatePaths: detects a path emitted by more than one renderer", () => {
  it("returns no errors when every path is unique across renderer outputs", () => {
    const outputs = [
      { platform: "a", files: [{ path: "one", contents: "1" }] },
      { platform: "b", files: [{ path: "two", contents: "2" }] },
    ];
    expect(findCrossPlatformDuplicatePaths(outputs)).toEqual([]);
  });

  it("reports the shared path and the platforms that both emit it", () => {
    const outputs = [
      { platform: "claude-code", files: [{ path: "shared.md", contents: "1" }] },
      { platform: "opencode", files: [{ path: "shared.md", contents: "2" }] },
    ];
    const errors = findCrossPlatformDuplicatePaths(outputs);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("shared.md");
    expect(errors[0]).toContain("claude-code");
    expect(errors[0]).toContain("opencode");
  });
});

describe("writeRenderedFiles / checkRenderedFiles against a temp output root", () => {
  let outRoot: string;

  beforeEach(async () => {
    outRoot = await mkdtemp(join(tmpdir(), "helpdesk-generator-"));
  });

  afterEach(async () => {
    await rm(outRoot, { recursive: true, force: true });
  });

  const files: readonly RenderedFile[] = [
    { path: ".claude/agents/triage.md", contents: "line one\nline two\n" },
    { path: ".mcp.json", contents: '{"a":1}\n' },
  ];

  it("writes every file, creating parent directories, with the exact contents", async () => {
    await writeRenderedFiles(files, outRoot);
    for (const file of files) {
      const onDisk = await readFile(join(outRoot, file.path), "utf8");
      expect(onDisk).toBe(file.contents);
    }
  });

  it("never writes a stray temp file next to the final path", async () => {
    await writeRenderedFiles(files, outRoot);
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(outRoot, ".claude/agents"));
    expect(entries).toEqual(["triage.md"]);
  });

  it("overwrites existing content at the same path on a second write", async () => {
    await writeRenderedFiles(files, outRoot);
    const updated = [{ path: ".mcp.json", contents: '{"a":2}\n' }];
    await writeRenderedFiles(updated, outRoot);
    const onDisk = await readFile(join(outRoot, ".mcp.json"), "utf8");
    expect(onDisk).toBe('{"a":2}\n');
  });

  it("checkRenderedFiles reports ok:true with no differences once the output root matches", async () => {
    await writeRenderedFiles(files, outRoot);
    const result = await checkRenderedFiles(files, outRoot);
    expect(result).toEqual({ ok: true, differences: [] });
  });

  it("checkRenderedFiles reports each missing file, never writing anything", async () => {
    const result = await checkRenderedFiles(files, outRoot);
    expect(result.ok).toBe(false);
    expect(result.differences).toEqual(
      expect.arrayContaining([
        { path: ".claude/agents/triage.md", reason: "missing" },
        { path: ".mcp.json", reason: "missing" },
      ]),
    );
    const { readdir } = await import("node:fs/promises");
    await expect(readdir(outRoot)).resolves.toEqual([]);
  });

  it("checkRenderedFiles reports a byte-level difference, naming the file", async () => {
    await writeRenderedFiles(files, outRoot);
    await writeFile(join(outRoot, ".mcp.json"), '{"a":9}\n', "utf8");
    const result = await checkRenderedFiles(files, outRoot);
    expect(result.ok).toBe(false);
    expect(result.differences).toEqual([{ path: ".mcp.json", reason: "differs" }]);
  });

  it("checkRenderedFiles flags an extra file inside a directory the generator owns", async () => {
    await writeRenderedFiles(files, outRoot);
    await writeFile(join(outRoot, ".claude/agents", "hand-added.md"), "not generated\n", "utf8");
    const result = await checkRenderedFiles(files, outRoot);
    expect(result.ok).toBe(false);
    expect(result.differences).toContainEqual({ path: ".claude/agents/hand-added.md", reason: "extra" });
  });

  it("checkRenderedFiles never flags a file outside a directory the generator owns", async () => {
    await writeRenderedFiles(files, outRoot);
    await mkdir(join(outRoot, ".claude/skills"), { recursive: true });
    await writeFile(join(outRoot, ".claude/skills", "unrelated.md"), "not ours\n", "utf8");
    const result = await checkRenderedFiles(files, outRoot);
    expect(result).toEqual({ ok: true, differences: [] });
  });
});

describe("runGenerate: the CLI's whole decision (validate -> render -> write|check)", () => {
  let outRoot: string;

  beforeEach(async () => {
    outRoot = await mkdtemp(join(tmpdir(), "helpdesk-generator-run-"));
  });

  afterEach(async () => {
    await rm(outRoot, { recursive: true, force: true });
  });

  it("a validation failure exits 1, reports every error, and writes nothing", async () => {
    const result = await runGenerate(cyclicModel(), { outRoot, check: false });
    expect(result.exitCode).toBe(1);
    expect(result.errors.some((e) => e.includes("handoff cycle"))).toBe(true);
    const { readdir } = await import("node:fs/promises");
    await expect(readdir(outRoot)).resolves.toEqual([]);
  });

  it("check:false writes every rendered file for a valid model and exits 0", async () => {
    const result = await runGenerate(model({}), { outRoot, check: false });
    expect(result).toEqual({ exitCode: 0, errors: [] });
    const onDisk = await readFile(join(outRoot, ".mcp.json"), "utf8");
    expect(onDisk).toContain('"helpdesk"');
  });

  it("check:true exits 0 with no errors once the output root already matches", async () => {
    await runGenerate(model({}), { outRoot, check: false });
    const result = await runGenerate(model({}), { outRoot, check: true });
    expect(result).toEqual({ exitCode: 0, errors: [] });
  });

  it("check:true exits 1 naming a missing file and writes nothing", async () => {
    const result = await runGenerate(model({}), { outRoot, check: true });
    expect(result.exitCode).toBe(1);
    expect(result.errors.some((e) => e.startsWith("missing: "))).toBe(true);
    const { readdir } = await import("node:fs/promises");
    await expect(readdir(outRoot)).resolves.toEqual([]);
  });
});
