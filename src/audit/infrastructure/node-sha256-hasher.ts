import { createHash } from "node:crypto";
import type { Hasher } from "../ports/hasher.js";

/** `Hasher` adapter backed by `node:crypto` (ADR 0012). */
export class NodeSha256Hasher implements Hasher {
  sha256Hex(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex");
  }
}
