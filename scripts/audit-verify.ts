#!/usr/bin/env node
/**
 * audit-verify — CLI wrapper over the pure `verifyChain` helper
 * (`src/audit/domain/hash-chain.ts`). Reads a JSONL audit log line by
 * line, recomputes every entry's hash, and compares against the stored
 * `prevHash`/`hash`. The detection it offers is the same one the
 * `jsonl-audit-log.test.ts` suite exercises on the helpers directly
 * (ADR 0014).
 *
 * Usage:
 *   audit-verify [path/to/audit.jsonl]
 *     default path: data/audit.jsonl (relative to the cwd)
 *
 * Exit codes:
 *   0 = chain is valid (every entry's stored hash matches
 *       sha256(prevHash + canonicalJson(entry))).
 *   1 = chain is broken at the printed `seq` (tampered entry,
 *       missing entry, or reorder).
 *   2 = usage / input error (log file does not exist, or contains a
 *       line that does not parse as a JSON object).
 *   3 = internal error.
 *
 * Why a CLI rather than an MCP tool: the operator runs this outside
 * the MCP server to confirm a known-good baseline before a deploy, or
 * to triage a suspicion of tampering without having to spin up a
 * model session. The MCP server itself never calls this script.
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { argv as processArgv, stderr, stdout } from "node:process";
import type { AuditEntry } from "../src/audit/domain/audit-entry.js";
import { type ChainVerification, verifyChain } from "../src/audit/domain/hash-chain.js";
import { NodeSha256Hasher } from "../src/audit/infrastructure/node-sha256-hasher.js";

/** Default audit log path, relative to the caller's cwd. */
export const DEFAULT_LOG_PATH = "data/audit.jsonl";

/**
 * Read every JSONL line, parse it as an `AuditEntry`, and run
 * `verifyChain` over the resulting sequence. Exported so tests can
 * call it without spawning a subprocess.
 *
 * A missing file is treated as an empty (valid) chain — there is
 * nothing to verify. A line that fails to parse is reported as a
 * break at the next expected `seq`, because that is exactly what an
 * attacker who deletes or corrupts a line produces from the
 * verifier's point of view (the next stored entry's `prevHash` will
 * not match what we recomputed).
 */
export async function verifyAuditFile(
  logPath: string,
  sha256Hex: (input: string) => string,
): Promise<ChainVerification & { readonly entryCount: number }> {
  if (!existsSync(logPath)) {
    return { valid: true, entryCount: 0 };
  }
  const fileStream = createReadStream(logPath, { encoding: "utf8" });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });
  const entries: AuditEntry[] = [];
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // First unparseable line breaks the chain at the next seq,
        // matching how the runtime `JsonlAuditLog` reacts on reopen.
        return { valid: false, brokenAtSeq: entries.length + 1, entryCount: entries.length };
      }
      entries.push(parsed as AuditEntry);
    }
  } finally {
    rl.close();
  }
  const result = verifyChain(sha256Hex, entries);
  return { ...result, entryCount: entries.length };
}

async function main(): Promise<number> {
  const logPath = processArgv[2] ?? DEFAULT_LOG_PATH;
  const hasher = new NodeSha256Hasher();
  try {
    const result = await verifyAuditFile(logPath, hasher.sha256Hex.bind(hasher));
    if (result.valid) {
      stdout.write(`ok: ${logPath} (chain valid, ${result.entryCount} entries)\n`);
      return 0;
    }
    stderr.write(`broken: ${logPath} at seq=${result.brokenAtSeq}\n`);
    return 1;
  } catch (err) {
    stderr.write(`internal: ${err instanceof Error ? err.message : String(err)}\n`);
    return 3;
  }
}

// Single-shot pattern matches `connectivity-probe.ts`: any leaked
// handle cannot keep the event loop alive past `process.exit`.
main().then(
  (code) => {
    process.exit(code);
  },
  (err) => {
    stderr.write(`internal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(3);
  },
);