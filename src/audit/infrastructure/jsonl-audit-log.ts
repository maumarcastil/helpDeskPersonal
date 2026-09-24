import { existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { AuditId, TicketId } from "../../shared/domain/ids.js";
import type { AuditEntry } from "../domain/audit-entry.js";
import { computeHash, GENESIS_HASH, type Sha256HexFn } from "../domain/hash-chain.js";
import type { AuditLog } from "../ports/audit-log.js";
import type { Hasher } from "../ports/hasher.js";

/**
 * File-backed append-only JSONL audit log (Phase 3, PR A). Each entry
 * is one line of JSON terminated with `\n`; `append` opens the file
 * with `O_APPEND` (via `fsp.appendFile`) so writes smaller than
 * PIPE_BUF are atomic on POSIX, which keeps two appends from
 * interleaving their bytes. In-process appends are additionally
 * serialized through a promise queue, so two `append()` calls fired
 * in the same tick apply in arrival order with no race on `seq`.
 *
 * Hash chain: each entry's `prevHash` is the previous entry's `hash`,
 * and the first entry's `prevHash` is `GENESIS_HASH`. `hash` =
 * `sha256(prevHash + canonicalJson(entry))` (the domain helpers in
 * `hash-chain.ts`, which we reuse rather than reimplementing). On open
 * we read the existing file once to learn the last hash, so closing
 * and reopening the file handle (the spec's "simulated process
 * restart") keeps the chain intact.
 *
 * Public surface is exactly `append` and `listByTicket`; there is
 * intentionally no `update`/`delete` method, which is itself the
 * enforcement of spec `audit-decision-log` -> "Attempt to modify a
 * past entry is rejected" (there is nothing to call).
 */
export class JsonlAuditLog implements AuditLog {
  private lastHash: string = GENESIS_HASH;
  private lastSeq: number = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly logPath: string;
  private readonly sha256Hex: Sha256HexFn;
  private loadPromise: Promise<void> | null = null;

  constructor(logPath: string, hasher: Hasher) {
    this.logPath = logPath;
    this.sha256Hex = (input: string) => hasher.sha256Hex(input);
  }

  async append(entry: Omit<AuditEntry, "seq" | "prevHash" | "hash">): Promise<AuditId> {
    return this.enqueueAppend(async () => {
      // Ensure the chain state reflects the on-disk file before we mint
      // a new entry. Idempotent: subsequent calls are no-ops after the
      // first load completes.
      await this.ensureLoaded();

      const seq = this.lastSeq + 1;
      const entryWithoutHash = { ...entry, seq };
      const hash = computeHash(this.sha256Hex, this.lastHash, entryWithoutHash);
      const chainedEntry: AuditEntry = {
        ...entryWithoutHash,
        prevHash: this.lastHash,
        hash,
      };

      await fsp.appendFile(this.logPath, `${JSON.stringify(chainedEntry)}\n`, "utf8");

      this.lastSeq = seq;
      this.lastHash = hash;
      return entry.id;
    });
  }

  async listByTicket(ticketId: TicketId): Promise<readonly AuditEntry[]> {
    await this.ensureLoaded();
    const all = await this.readAllEntries();
    return all.filter((e) => e.ticketId === ticketId);
  }

  /** Idempotent load: read the file once to learn `lastHash`/`lastSeq`,
   *  then cache the promise. Concurrent `append`/`listByTicket` callers
   *  share the same load rather than racing. A missing file means
   *  fresh state (genesis hash, seq 0). */
  private ensureLoaded(): Promise<void> {
    if (this.loadPromise !== null) return this.loadPromise;
    this.loadPromise = this.loadFromDisk();
    return this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    if (!existsSync(this.logPath)) {
      this.lastHash = GENESIS_HASH;
      this.lastSeq = 0;
      return;
    }
    const entries = await this.readAllEntries();
    const lastEntry = entries[entries.length - 1];
    if (!lastEntry) {
      this.lastHash = GENESIS_HASH;
      this.lastSeq = 0;
      return;
    }
    this.lastHash = lastEntry.hash;
    this.lastSeq = lastEntry.seq;
  }

  private async readAllEntries(): Promise<readonly AuditEntry[]> {
    if (!existsSync(this.logPath)) return [];
    const fileStream = createReadStream(this.logPath, { encoding: "utf8" });
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });
    const entries: AuditEntry[] = [];
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          entries.push(JSON.parse(trimmed) as AuditEntry);
        } catch {
          // Malformed line: stop reading at the first unparseable
          // entry. (A healthy log never has one; this is a defensive
          // guard so a future regression does not silently corrupt
          // the chain on next append.)
          break;
        }
      }
    } finally {
      rl.close();
    }
    return entries;
  }

  /**
   * Append `work` to the in-process queue. Two `append()` calls fired
   * in the same tick therefore run sequentially: the second awaits
   * the first's completion (success OR failure) before it starts. The
   * queue itself never settles to a rejected state, so a single
   * failing append cannot poison the next call.
   */
  private enqueueAppend<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(() => work(), () => work());
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
