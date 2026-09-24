import { REDACTION_PATTERNS, type RedactionKind } from "./patterns.js";
import type { RedactedText } from "./redacted-text.js";

export interface RedactionFinding {
  readonly kind: RedactionKind;
  readonly count: number;
}

interface ClaimedMatch {
  readonly kind: RedactionKind;
  readonly start: number;
  readonly end: number;
}

function findCandidates(
  pattern: (typeof REDACTION_PATTERNS)[number],
  text: string,
): ClaimedMatch[] {
  const matches: ClaimedMatch[] = [];
  const flags = pattern.regex.flags.includes("g")
    ? pattern.regex.flags
    : `${pattern.regex.flags}g`;
  const regex = new RegExp(pattern.regex.source, flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const matchedText = match[0];
    if (matchedText.length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    if (!pattern.validate || pattern.validate(matchedText)) {
      matches.push({
        kind: pattern.kind,
        start: match.index,
        end: match.index + matchedText.length,
      });
    }
  }
  return matches;
}

function overlaps(a: ClaimedMatch, b: { start: number; end: number }): boolean {
  return a.start < b.end && a.end > b.start;
}

/**
 * Replaces every recognized secret/PII substring of `input` with
 * `[REDACTED:<KIND>]` and reports findings (kind + count, never the
 * value). Patterns are tried in `REDACTION_PATTERNS` order (specific
 * before generic); a region already claimed by an earlier pattern is never
 * re-claimed by a later one, so e.g. a JWT match wins over an overlapping
 * HIGH_ENTROPY match on the same substring (spec `sensitive-data-redaction`).
 */
export function redact(input: string): {
  text: RedactedText;
  findings: RedactionFinding[];
} {
  const claimed: ClaimedMatch[] = [];
  for (const pattern of REDACTION_PATTERNS) {
    for (const candidate of findCandidates(pattern, input)) {
      if (!claimed.some((existing) => overlaps(existing, candidate))) {
        claimed.push(candidate);
      }
    }
  }
  claimed.sort((a, b) => a.start - b.start);

  let cursor = 0;
  let output = "";
  const counts = new Map<RedactionKind, number>();
  for (const match of claimed) {
    output += input.slice(cursor, match.start);
    output += `[REDACTED:${match.kind}]`;
    counts.set(match.kind, (counts.get(match.kind) ?? 0) + 1);
    cursor = match.end;
  }
  output += input.slice(cursor);

  const findings: RedactionFinding[] = [...counts.entries()].map(([kind, count]) => ({
    kind,
    count,
  }));
  return { text: output as RedactedText, findings };
}

/** Walks a JSON-like value and redacts every string leaf in place (structural copy). */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") {
    return redact(value).text as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactDeep(nested);
    }
    return result as T;
  }
  return value;
}
