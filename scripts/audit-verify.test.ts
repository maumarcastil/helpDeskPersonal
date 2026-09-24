import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlAuditLog } from "../src/audit/infrastructure/jsonl-audit-log.js";
import { NodeSha256Hasher } from "../src/audit/infrastructure/node-sha256-hasher.js";
import type { AuditId, TicketId } from "../src/shared/domain/ids.js";

interface SpawnResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const VERIFY_SCRIPT = resolvePath(__dirname, "../scripts/audit-verify.ts");
const TSX_BIN = resolvePath(__dirname, "../node_modules/.bin/tsx");

/**
 * Spawn the audit-verify CLI exactly the way `npm run audit:verify`
 * will: `node <tsxBin> <script> [path]`. Inherits the caller's cwd so
 * the script's default `data/audit.jsonl` resolves relative to the
 * same directory operators will use.
 */
function spawnVerify(args: readonly string[], cwd?: string): Promise<SpawnResult> {
  return new Promise<SpawnResult>((done) => {
    const child: ChildProcess = spawn("node", [TSX_BIN, VERIFY_SCRIPT, ...args], {
      ...(cwd !== undefined ? { cwd } : {}),
      env: {
        ...process.env,
        // Defence in depth: an unrelated PSEUDONYM-like key the
        // runner never sees should not surface from the test process
        // either.
        HELPDESK_PSEUDONYM_KEY: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (status) => {
      done({ status, stdout, stderr });
    });
  });
}

let workDir: string;
let logPath: string;
let hasher: NodeSha256Hasher;

beforeEach(() => {
  workDir = join(tmpdir(), `helpdesk-audit-verify-${randomBytes(6).toString("hex")}`);
  mkdirSync(workDir, { recursive: true });
  logPath = join(workDir, "audit.jsonl");
  hasher = new NodeSha256Hasher();
});

afterEach(() => {
  if (existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

/** Append a real, hash-chained entry via `JsonlAuditLog` so the file
 *  on disk is guaranteed to satisfy `verifyChain` until we tamper.
 *  Each call uses a fresh ticket id so per-ticket ordering tests
 *  are not coupled to a shared ticket. */
async function append(
  type:
    | "ticket.created"
    | "ticket.transitioned"
    | "remediation.applied"
    | "agent.note",
  message: string,
): Promise<void> {
  const log = new JsonlAuditLog(logPath, hasher);
  const ticketId = `tkt_${randomBytes(6).toString("hex")}` as TicketId;
  await log.append({
    id: `aud_${randomBytes(6).toString("hex")}` as AuditId,
    at: new Date().toISOString(),
    ticketId,
    actor: "system",
    type,
    message: message as never,
    data: {},
  });
}

describe("audit-verify script", () => {
  describe("missing file", () => {
    it("exits 0 with an explicit 'empty chain' message when the log path does not exist", async () => {
      const result = await spawnVerify([logPath]);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/chain valid.*0 entries/);
    });
  });

  describe("valid chain", () => {
    it("exits 0 and reports 'ok' for a freshly written, single-entry chain (genesis prevHash)", async () => {
      await append("ticket.created", "first entry");
      const result = await spawnVerify([logPath]);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/chain valid.*1 entries/);
    });

    it("exits 0 and reports the entry count for a 3-entry chain", async () => {
      await append("ticket.created", "first");
      await append("ticket.transitioned", "second");
      await append("ticket.transitioned", "third");
      const result = await spawnVerify([logPath]);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/chain valid.*3 entries/);
    });
  });

  describe("tampered chain", () => {
    it("exits 1 and reports seq=1 when the very first entry's content has been mutated on disk", async () => {
      await append("ticket.created", "first");
      await append("ticket.transitioned", "second");

      // Tamper with the first entry's message field directly on
      // disk, then rewrite the file. The stored `hash` no longer
      // matches `sha256(prevHash + canonicalJson(entry))`.
      const raw = readFileSync(logPath, "utf8").trim().split("\n");
      const firstEntry = JSON.parse(raw[0] as string) as Record<string, unknown>;
      firstEntry["message"] = "tampered";
      raw[0] = JSON.stringify(firstEntry);
      writeFileSync(logPath, raw.join("\n") + "\n");

      const result = await spawnVerify([logPath]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/broken.*seq=1/);
    });

    it("exits 1 and reports the broken seq when a middle entry's content is mutated", async () => {
      await append("ticket.created", "first");
      await append("ticket.transitioned", "second");
      await append("ticket.transitioned", "third");

      const raw = readFileSync(logPath, "utf8").trim().split("\n");
      const secondEntry = JSON.parse(raw[1] as string) as Record<string, unknown>;
      secondEntry["message"] = "tampered";
      raw[1] = JSON.stringify(secondEntry);
      writeFileSync(logPath, raw.join("\n") + "\n");

      const result = await spawnVerify([logPath]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/broken.*seq=2/);
    });

    it("exits 1 and reports a broken seq when a line is unparseable JSON", async () => {
      await append("ticket.created", "first");
      await append("ticket.transitioned", "second");
      // Inject garbage after the first valid line; the parser stops
      // there and reports the next expected seq as broken.
      writeFileSync(logPath, `${readFileSync(logPath, "utf8")}not-valid-json\n`);

      const result = await spawnVerify([logPath]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/broken.*seq=3/);
    });
  });

  describe("CLI surface", () => {
    it("uses data/audit.jsonl as the default path when no argument is supplied (cwd matters; we just check the path is referenced)", async () => {
      // We exercise the default by spawning without args from a temp
      // cwd that has no `data/audit.jsonl`. Result must be exit 0
      // with '0 entries', confirming the script picked the default
      // path (rather than a hard-coded repo path) and found nothing.
      const result = await spawnVerify([], workDir);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/data\/audit\.jsonl/);
      expect(result.stdout).toMatch(/0 entries/);
    });
  });
});

// Touch the shared hasher so an unrelated refactor cannot remove the
// import without breaking this test's fixtures.
void NodeSha256Hasher;