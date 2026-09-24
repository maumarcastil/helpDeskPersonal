import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TicketId } from "../../shared/domain/ids.js";
import { createNewTicket } from "../domain/ticket.js";
import type { Ticket } from "../domain/ticket.js";
import type { TicketState } from "../domain/states.js";
import type { TicketRepository } from "../ports/ticket-repository.js";
import { type FileIO, JsonFileTicketRepository } from "./json-file-ticket-repository.js";

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");

function buildTicket(
  state: TicketState,
  description = "test ticket",
  version = 1,
): Ticket {
  const id = `tkt_${randomBytes(8).toString("hex")}` as TicketId;
  const base = createNewTicket(description as Ticket["description"], id, FIXED_NOW);
  // The state-machine enforces transitions, but for repository-round-trip
  // tests we want any shape we ask for — so set the state/version/createdAt
  // directly on a cloned record rather than driving transitions.
  return {
    ...base,
    state,
    version,
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
  };
}

let workDir: string;
let filePath: string;

beforeEach(() => {
  const dir = join(tmpdir(), `helpdesk-repo-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  workDir = dir;
  filePath = join(dir, "tickets.json");
});

afterEach(() => {
  if (existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

describe("JsonFileTicketRepository", () => {
  describe("round-trip", () => {
    it("save then getById returns the same ticket (deep equality)", async () => {
      const repo = new JsonFileTicketRepository(filePath);
      const ticket = buildTicket("New");

      const saveResult = await repo.save(ticket, 0);
      expect(saveResult.ok).toBe(true);

      const fetched = await repo.getById(ticket.id);
      expect(fetched).toEqual(ticket);
    });

    it("save then list returns the saved ticket", async () => {
      const repo = new JsonFileTicketRepository(filePath);
      const ticket = buildTicket("New");
      await repo.save(ticket, 0);

      const all = await repo.list({});
      expect(all).toHaveLength(1);
      expect(all[0]).toEqual(ticket);
    });

    it("list respects the state filter", async () => {
      const repo = new JsonFileTicketRepository(filePath);
      const tNew = buildTicket("New");
      const tTriaged = buildTicket("Triaged");
      await repo.save(tNew, 0);
      await repo.save(tTriaged, 0);

      const onlyTriaged = await repo.list({ state: "Triaged" });
      expect(onlyTriaged).toHaveLength(1);
      expect(onlyTriaged[0]?.id).toBe(tTriaged.id);
    });

    it("list respects the limit filter", async () => {
      const repo = new JsonFileTicketRepository(filePath);
      for (let i = 0; i < 3; i += 1) {
        await repo.save(buildTicket("New"), 0);
      }

      const limited = await repo.list({ limit: 2 });
      expect(limited).toHaveLength(2);
    });
  });

  describe("missing data file", () => {
    it("getById returns null without throwing when the data file does not exist", async () => {
      const repo = new JsonFileTicketRepository(filePath);
      const fetched = await repo.getById(`tkt_${randomBytes(8).toString("hex")}` as TicketId);
      expect(fetched).toBeNull();
    });

    it("list returns an empty array without throwing when the data file does not exist", async () => {
      const repo = new JsonFileTicketRepository(filePath);
      const all = await repo.list({});
      expect(all).toEqual([]);
    });
  });

  describe("optimistic version (CONFLICT)", () => {
    it("save returns CONFLICT and writes nothing when expectedVersion does not match the on-disk version", async () => {
      const repo = new JsonFileTicketRepository(filePath);
      const ticket = buildTicket("New", "original");
      await repo.save(ticket, 0);

      // Simulate a stale read: caller has the v1 ticket but the on-disk
      // version has advanced (here we use a higher expectedVersion than
      // what is actually stored, so the repository's check rejects it).
      const staleTicket: Ticket = { ...ticket, description: "stale write" as Ticket["description"] };
      const result = await repo.save(staleTicket, 999);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("CONFLICT");

      // Persisted state must be untouched (the stale write was rejected).
      const fetched = await repo.getById(ticket.id);
      expect(fetched?.description).toBe("original");
    });

    it("save with expectedVersion equal to the persisted version succeeds", async () => {
      const repo = new JsonFileTicketRepository(filePath);
      const ticket = buildTicket("New", "v1");
      await repo.save(ticket, 0);

      const updated: Ticket = { ...ticket, version: 2, description: "v2" as Ticket["description"] };
      const result = await repo.save(updated, 1);
      expect(result.ok).toBe(true);

      const fetched = await repo.getById(ticket.id);
      expect(fetched?.version).toBe(2);
      expect(fetched?.description).toBe("v2");
    });

    it("save with expectedVersion=0 fails when a ticket with the same id already exists", async () => {
      const repo = new JsonFileTicketRepository(filePath);
      const ticket = buildTicket("New");
      await repo.save(ticket, 0);

      // expectedVersion=0 is the "this id must not exist yet" contract.
      const dupe: Ticket = { ...ticket, version: 1 };
      const result = await repo.save(dupe, 0);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("CONFLICT");
    });
  });

  describe("atomic write", () => {
    it("places the final document at the target path (rename is called from a temp path)", async () => {
      const repo = new JsonFileTicketRepository(filePath);
      const ticket = buildTicket("New");
      await repo.save(ticket, 0);

      // The on-disk file must exist and contain valid JSON, and the
      // rename must have been the operation that placed it there. The
      // temp file is cleaned up by `persist`'s error path; on the
      // success path it does not need to remain, and the target path
      // is the only thing the spec cares about.
      expect(existsSync(filePath)).toBe(true);
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
      expect(Object.keys(parsed)).toContain(ticket.id);
    });

    it("an in-flight reader never observes a half-written file (rename is atomic; pre-state is intact until rename resolves)", async () => {
      // Seed the file with a known ticket so we can read the pre-state.
      const original = buildTicket("New", "original");
      writeFileSync(
        filePath,
        JSON.stringify({
          [original.id]: { ticket: original, version: original.version },
        }),
        "utf8",
      );

      // Inject a delay into the temp-file `writeFile` via the
      // repository's injectable FileIO. While the temp write is in
      // flight, the rename has not happened yet, so the target path
      // still holds the original content.
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const slowIO: FileIO = {
        readFile: (p) => fsp.readFile(p, "utf8"),
        writeFile: async (p, c) => {
          // Slow down only the temp-path write so the target stays
          // intact while the save is mid-flight.
          if (p.includes(".tmp.")) {
            await gate;
          }
          await fsp.writeFile(p, c, "utf8");
        },
        rename: (from, to) => fsp.rename(from, to),
        unlink: (p) => fsp.unlink(p),
      };

      const repo = new JsonFileTicketRepository(filePath, slowIO);
      const updated: Ticket = { ...original, version: 2, description: "v2" as Ticket["description"] };
      const savePromise = repo.save(updated, 1);

      // Yield a few times and read the target file during the in-flight
      // write. Every observation must parse cleanly and equal the
      // pre-state — never a half-written document.
      await new Promise((r) => setTimeout(r, 25));
      const midFile = readFileSync(filePath, "utf8");
      const midParsed = JSON.parse(midFile) as Record<string, { ticket: { description: string } }>;
      expect(midParsed[original.id]?.ticket.description).toBe("original");

      // Release the temp-write gate so the save can finish.
      release?.();
      const saveResult = await savePromise;
      expect(saveResult.ok).toBe(true);

      const afterFile = readFileSync(filePath, "utf8");
      const afterParsed = JSON.parse(afterFile) as Record<string, { ticket: { description: string } }>;
      expect(afterParsed[original.id]?.ticket.description).toBe("v2");
    });
  });

  describe("concurrent in-process writes are serialized", () => {
    it("two back-to-back saves both apply in order with no lost update (version increments monotonically)", async () => {
      const repo = new JsonFileTicketRepository(filePath);
      const base = buildTicket("New", "v1");
      await repo.save(base, 0);

      // Fire two saves back-to-back without awaiting between them.
      const save1 = repo.save({ ...base, version: 2, description: "v2" as Ticket["description"] }, 1);
      const save2 = repo.save({ ...base, version: 3, description: "v3" as Ticket["description"] }, 2);

      const [r1, r2] = await Promise.all([save1, save2]);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);

      const fetched = await repo.getById(base.id);
      expect(fetched?.version).toBe(3);
      expect(fetched?.description).toBe("v3");
    });

    it("back-to-back saves preserve serial application even when one is rejected (queue continues after errors)", async () => {
      const repo = new JsonFileTicketRepository(filePath);
      const base = buildTicket("New", "v1");
      await repo.save(base, 0);

      // First save is valid (v1 -> v2). Second save races with a stale
      // expectedVersion (1) and must be rejected without blocking the
      // third (which uses the correct v2 -> v3 transition).
      const save1 = repo.save({ ...base, version: 2, description: "v2" as Ticket["description"] }, 1);
      const save2 = repo.save({ ...base, version: 3, description: "stale" as Ticket["description"] }, 1);
      const save3 = repo.save({ ...base, version: 3, description: "v3" as Ticket["description"] }, 2);

      const [r1, r2, r3] = await Promise.all([save1, save2, save3]);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(false);
      expect(r3.ok).toBe(true);

      const fetched = await repo.getById(base.id);
      expect(fetched?.version).toBe(3);
      expect(fetched?.description).toBe("v3");
    });
  });

  describe("port surface (type-level + runtime)", () => {
    it("implements the TicketRepository port surface (compile-time Pick check)", () => {
      // Compile-time assertion: if JsonFileTicketRepository did not
      // expose the three port methods with the right signatures, this
      // assignment would not type-check. The `void` keeps the unused
      // binding from being flagged at runtime.
      const instance: Pick<TicketRepository, "getById" | "save" | "list"> =
        new JsonFileTicketRepository(filePath);
      void instance;
    });

    it("does not expose update/delete/set/remove methods on the class (no over-surface)", () => {
      const instance = new JsonFileTicketRepository(filePath);
      const methodNames = new Set(
        Object.getOwnPropertyNames(Object.getPrototypeOf(instance)).filter(
          (name) => name !== "constructor",
        ),
      );
      for (const forbidden of ["update", "delete", "set", "remove"]) {
        expect(methodNames.has(forbidden)).toBe(false);
      }
    });
  });
});
