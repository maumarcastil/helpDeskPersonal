import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { domainError, type DomainError } from "../../shared/domain/domain-error.js";
import type { TicketId } from "../../shared/domain/ids.js";
import { err, ok, type Result } from "../../shared/kernel/result.js";
import type { Ticket } from "../domain/ticket.js";
import type { TicketListFilter, TicketRepository } from "../ports/ticket-repository.js";

interface TicketEntry {
  readonly ticket: Ticket;
  readonly version: number;
}

/**
 * File-system operations the repository needs. Split out into a small
 * interface so tests can inject a slow `writeFile` (or any other
 * behavior) without monkey-patching the built-in `node:fs/promises`
 * namespace, which ESM forbids. The default implementation delegates
 * to `node:fs/promises`.
 */
export interface FileIO {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const defaultFileIO: FileIO = {
  async readFile(p) {
    return fsp.readFile(p, "utf8");
  },
  async writeFile(p, c) {
    await fsp.writeFile(p, c, "utf8");
  },
  rename: (from, to) => fsp.rename(from, to),
  unlink: (p) => fsp.unlink(p),
};

/**
 * File-backed `TicketRepository` (Phase 3, PR A). On-disk layout: a
 * single JSON object whose keys are ticket ids and whose values are
 * `{ ticket, version }` pairs. Saves go to a temp file in the same
 * directory followed by an atomic `rename`, so a concurrent reader
 * never sees a half-written document: the file is either the prior
 * state or the new state. In-process writes are serialized through a
 * promise queue so two `save()` calls fired back-to-back apply in
 * arrival order without an interleaving race inside the repository.
 *
 * Convention: `expectedVersion: 0` means "no ticket with this id may
 * already exist" (first save of a new ticket by `CreateTicket`, whose
 * `Ticket.version` is already `1`). The on-disk `version` field equals
 * the stored ticket's `Ticket.version`; on `save` we compare the
 * caller's `expectedVersion` against the on-disk version and reject
 * with `CONFLICT` on mismatch without writing.
 */
export class JsonFileTicketRepository implements TicketRepository {
  private cache: Map<TicketId, TicketEntry> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly filePath: string;
  private readonly io: FileIO;

  constructor(filePath: string, io: FileIO = defaultFileIO) {
    this.filePath = filePath;
    this.io = io;
  }

  async getById(id: TicketId): Promise<Ticket | null> {
    await this.loadCache();
    return this.requireCache().get(id)?.ticket ?? null;
  }

  async list(filter: TicketListFilter): Promise<readonly Ticket[]> {
    await this.loadCache();
    let tickets = [...this.requireCache().values()].map((entry) => entry.ticket);
    if (filter.state !== undefined) {
      tickets = tickets.filter((t) => t.state === filter.state);
    }
    if (filter.category !== undefined) {
      tickets = tickets.filter((t) => t.triage?.category === filter.category);
    }
    if (filter.priority !== undefined) {
      tickets = tickets.filter((t) => t.triage?.priority === filter.priority);
    }
    if (filter.limit !== undefined) {
      tickets = tickets.slice(0, filter.limit);
    }
    return tickets;
  }

  async save(ticket: Ticket, expectedVersion: number): Promise<Result<void, DomainError>> {
    return this.enqueueWrite(async () => {
      await this.loadCache();
      const cache = this.requireCache();
      const current = cache.get(ticket.id);
      const currentVersion = current?.version ?? 0;

      if (currentVersion !== expectedVersion) {
        return err(
          domainError(
            "CONFLICT",
            `version mismatch: expected ${expectedVersion}, got ${currentVersion}`,
            { ticketId: ticket.id, expectedVersion, currentVersion },
          ),
        );
      }

      cache.set(ticket.id, { ticket, version: ticket.version });
      await this.persist();
      return ok(undefined);
    });
  }

  /** Load the entire data file into the in-memory cache. A missing
   *  file becomes an empty cache rather than throwing — `getById` /
   *  `list` then behave as if the repository has no tickets. */
  private async loadCache(): Promise<void> {
    if (this.cache !== null) return;
    let content: string;
    try {
      content = await this.io.readFile(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = new Map();
        return;
      }
      throw err;
    }
    const parsed = JSON.parse(content) as Record<string, TicketEntry>;
    this.cache = new Map(
      Object.entries(parsed).map(([id, entry]) => [id as TicketId, entry]),
    );
  }

  private requireCache(): Map<TicketId, TicketEntry> {
    if (this.cache === null) {
      throw new Error("cache not loaded; loadCache() must run first");
    }
    return this.cache;
  }

  /**
   * Append `work` to the in-process write queue. Two `save()` calls
   * fired in the same tick therefore run sequentially: the second
   * awaits the first's completion (success OR failure) before it
   * starts. The queue itself never settles to a rejected state, so a
   * single failing save cannot poison the next call.
   */
  private enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(() => work(), () => work());
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Write the current cache to a temp file in the same directory and
   * atomically rename it onto the target path. `rename(2)` is atomic on
   * the same filesystem on POSIX, so a concurrent reader of the target
   * path sees either the prior contents or the new contents — never a
   * partial document. The temp file name includes pid + nanos + random
   * so two concurrent saves (already impossible in-process thanks to
   * `enqueueWrite`, but possible across processes) cannot collide.
   */
  private async persist(): Promise<void> {
    const cache = this.requireCache();
    const dir = path.dirname(this.filePath);
    const tempPath = path.join(
      dir,
      `.${path.basename(this.filePath)}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`,
    );
    const serializable: Record<string, TicketEntry> = Object.fromEntries(cache);
    const content = JSON.stringify(serializable, null, 2);

    try {
      await this.io.writeFile(tempPath, content);
      await this.io.rename(tempPath, this.filePath);
    } catch (err) {
      // Best-effort cleanup so the temp file does not accumulate on
      // disk if the rename fails (e.g. cross-device move, EACCES).
      try {
        await this.io.unlink(tempPath);
      } catch {
        // ignore
      }
      throw err;
    }
  }
}
