import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditEntry } from "../domain/audit-entry.js";
import { GENESIS_HASH, verifyChain } from "../domain/hash-chain.js";
import type { AuditId, TicketId } from "../../shared/domain/ids.js";
import { NodeSha256Hasher } from "./node-sha256-hasher.js";
import { JsonlAuditLog } from "./jsonl-audit-log.js";

const FIXED_ISO = "2026-01-01T00:00:00.000Z";

let workDir: string;
let logPath: string;
let hasher: NodeSha256Hasher;

beforeEach(() => {
  const dir = join(tmpdir(), `helpdesk-audit-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  workDir = dir;
  logPath = join(dir, "audit.jsonl");
  hasher = new NodeSha256Hasher();
});

afterEach(() => {
  if (existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

function buildEntry(overrides: {
  id?: AuditId;
  seq?: number;
  ticketId?: TicketId;
  type?: AuditEntry["type"];
  message?: string;
  at?: string;
} = {}): Omit<AuditEntry, "seq" | "prevHash" | "hash"> {
  return {
    id: (overrides.id ?? `aud_${randomBytes(8).toString("hex")}`) as AuditId,
    at: overrides.at ?? FIXED_ISO,
    ...(overrides.ticketId !== undefined ? { ticketId: overrides.ticketId } : {}),
    actor: "system",
    type: overrides.type ?? "agent.note",
    message: (overrides.message ?? "entry") as AuditEntry["message"],
    data: {},
  };
}

describe("JsonlAuditLog", () => {
  describe("append + listByTicket order", () => {
    it("listByTicket returns entries in chronological (append) order across multiple appends", async () => {
      const log = new JsonlAuditLog(logPath, hasher);
      const ticketId = `tkt_${randomBytes(8).toString("hex")}` as TicketId;

      const id1 = await log.append(buildEntry({ ticketId, type: "ticket.created" }));
      const id2 = await log.append(buildEntry({ ticketId, type: "ticket.transitioned" }));
      const id3 = await log.append(buildEntry({ ticketId, type: "ticket.transitioned" }));

      const listed = await log.listByTicket(ticketId);
      expect(listed.map((e) => e.id)).toEqual([id1, id2, id3]);
      expect(listed.map((e) => e.seq)).toEqual([1, 2, 3]);
    });

    it("appends across multiple tickets preserve per-ticket ordering", async () => {
      const log = new JsonlAuditLog(logPath, hasher);
      const tktA = `tkt_${randomBytes(8).toString("hex")}` as TicketId;
      const tktB = `tkt_${randomBytes(8).toString("hex")}` as TicketId;

      await log.append(buildEntry({ ticketId: tktA, type: "ticket.created" }));
      await log.append(buildEntry({ ticketId: tktB, type: "ticket.created" }));
      await log.append(buildEntry({ ticketId: tktA, type: "ticket.transitioned" }));
      await log.append(buildEntry({ ticketId: tktB, type: "ticket.transitioned" }));

      const listA = await log.listByTicket(tktA);
      const listB = await log.listByTicket(tktB);

      expect(listA.map((e) => e.seq)).toEqual([1, 3]);
      expect(listB.map((e) => e.seq)).toEqual([2, 4]);
    });

    it("appends a ticket-less entry and listByTicket filters it out", async () => {
      const log = new JsonlAuditLog(logPath, hasher);
      const ticketId = `tkt_${randomBytes(8).toString("hex")}` as TicketId;
      await log.append(buildEntry({ type: "config.warning" }));
      await log.append(buildEntry({ ticketId, type: "ticket.created" }));
      await log.append(buildEntry({ type: "agent.note" }));

      const listed = await log.listByTicket(ticketId);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.type).toBe("ticket.created");
    });
  });

  describe("hash chain", () => {
    it("every entry has the expected shape: monotonically increasing seq, prevHash = previous hash, hash = sha256(prevHash + canonicalJson(entry))", async () => {
      const log = new JsonlAuditLog(logPath, hasher);
      const ticketId = `tkt_${randomBytes(8).toString("hex")}` as TicketId;
      await log.append(buildEntry({ ticketId, type: "ticket.created" }));
      await log.append(buildEntry({ ticketId, type: "ticket.transitioned" }));
      await log.append(buildEntry({ ticketId, type: "ticket.transitioned" }));

      const listed = await log.listByTicket(ticketId);
      // listByTicket only returns entries with this ticketId; read the
      // raw file so we can verify the chain across all entries (the
      // ticket-less entries must be in the chain too).
      const raw = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as AuditEntry);
      const sha256Hex = hasher.sha256Hex.bind(hasher);
      const verification = verifyChain(sha256Hex, raw);
      expect(verification).toEqual({ valid: true });

      // Spot-check the first entry: prevHash must be the genesis.
      const first = raw[0];
      expect(first?.prevHash).toBe(GENESIS_HASH);
      expect(first?.seq).toBe(1);

      // The second entry's prevHash must equal the first entry's hash.
      const second = raw[1];
      expect(second?.prevHash).toBe(first?.hash);
      expect(second?.seq).toBe(2);

      // The third entry's prevHash must equal the second entry's hash.
      const third = raw[2];
      expect(third?.prevHash).toBe(second?.hash);
      expect(third?.seq).toBe(3);

      // listed contains the per-ticket subset, ordered identically.
      expect(listed.map((e) => e.seq)).toEqual([1, 2, 3]);
    });

    it("hash chain stays continuous across a simulated process restart (close + reopen the file handle, append again, re-verify the full chain)", async () => {
      const ticketId = `tkt_${randomBytes(8).toString("hex")}` as TicketId;

      // First "process" — append two entries, then close (drop the
      // instance, releasing any in-memory state).
      const firstLog = new JsonlAuditLog(logPath, hasher);
      await firstLog.append(buildEntry({ ticketId, type: "ticket.created" }));
      await firstLog.append(buildEntry({ ticketId, type: "ticket.transitioned" }));

      // Second "process" — fresh instance must read the on-disk file,
      // learn the last hash, and chain the next entry to it.
      const secondLog = new JsonlAuditLog(logPath, hasher);
      await secondLog.append(buildEntry({ ticketId, type: "remediation.applied" }));

      // Re-open a third time and append one more — every entry across
      // the three "processes" must form one continuous chain.
      const thirdLog = new JsonlAuditLog(logPath, hasher);
      await thirdLog.append(buildEntry({ ticketId, type: "ticket.transitioned" }));

      const raw = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as AuditEntry);
      expect(raw).toHaveLength(4);
      expect(raw.map((e) => e.seq)).toEqual([1, 2, 3, 4]);

      const sha256Hex = hasher.sha256Hex.bind(hasher);
      const verification = verifyChain(sha256Hex, raw);
      expect(verification).toEqual({ valid: true });

      // First entry chains to genesis.
      expect(raw[0]?.prevHash).toBe(GENESIS_HASH);
      // Each subsequent entry's prevHash equals the prior entry's hash.
      for (let i = 1; i < raw.length; i += 1) {
        expect(raw[i]?.prevHash).toBe(raw[i - 1]?.hash);
      }
    });

    it("a manually tampered entry's hash mismatch is detected by verifyChain (sanity check for the helpers reused)", async () => {
      const log = new JsonlAuditLog(logPath, hasher);
      const ticketId = `tkt_${randomBytes(8).toString("hex")}` as TicketId;
      await log.append(buildEntry({ ticketId, type: "ticket.created" }));
      await log.append(buildEntry({ ticketId, type: "ticket.transitioned" }));

      const raw = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as AuditEntry);

      // Mutate the first entry's message after-the-fact (an attacker
      // would do this directly on disk). The chain must detect it.
      const tampered = raw.map((entry, idx) =>
        idx === 0 ? { ...entry, message: "tampered" as AuditEntry["message"] } : entry,
      );
      const sha256Hex = hasher.sha256Hex.bind(hasher);
      const verification = verifyChain(sha256Hex, tampered);
      expect(verification).toEqual({ valid: false, brokenAtSeq: 1 });
    });
  });

  describe("public surface (port surface check)", () => {
    it("implements the AuditLog port surface (compile-time Pick check)", () => {
      // Compile-time assertion: if JsonlAuditLog did not expose append +
      // listByTicket with the right signatures, this assignment would
      // fail to type-check.
      type PortSurface = Pick<JsonlAuditLog, "append" | "listByTicket">;
      const instance: PortSurface = new JsonlAuditLog(logPath, hasher);
      void instance;
    });

    it("does not expose update/delete/set/remove methods on the class (append-only)", () => {
      const instance = new JsonlAuditLog(logPath, hasher);
      const methodNames = new Set(
        Object.getOwnPropertyNames(Object.getPrototypeOf(instance)).filter(
          (name) => name !== "constructor",
        ),
      );
      for (const forbidden of ["update", "delete", "set", "remove", "clear"]) {
        expect(methodNames.has(forbidden)).toBe(false);
      }
      // Sanity: the port methods ARE present.
      expect(methodNames.has("append")).toBe(true);
      expect(methodNames.has("listByTicket")).toBe(true);
    });
  });

  describe("missing log file", () => {
    it("listByTicket on an empty (missing) log returns an empty array without throwing", async () => {
      const log = new JsonlAuditLog(logPath, hasher);
      const ticketId = `tkt_${randomBytes(8).toString("hex")}` as TicketId;
      const listed = await log.listByTicket(ticketId);
      expect(listed).toEqual([]);
    });

    it("appending the first entry chains it to the genesis hash", async () => {
      const log = new JsonlAuditLog(logPath, hasher);
      const ticketId = `tkt_${randomBytes(8).toString("hex")}` as TicketId;
      await log.append(buildEntry({ ticketId, type: "ticket.created" }));

      const raw = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as AuditEntry);
      expect(raw).toHaveLength(1);
      expect(raw[0]?.seq).toBe(1);
      expect(raw[0]?.prevHash).toBe(GENESIS_HASH);
    });
  });
});
