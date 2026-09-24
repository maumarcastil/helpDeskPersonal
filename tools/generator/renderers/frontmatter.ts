/**
 * A tiny, dependency-free YAML frontmatter emitter (task 6.6, PR B). The
 * three renderers only ever need to emit a handful of value shapes — a
 * scalar, a flat list of strings, a list of small flat mappings (VS Code's
 * `handoffs`), and a mapping of mappings (OpenCode's `permission.task`) — so
 * a full YAML library is not worth the new dependency ADR 0009 warns
 * against; this module covers exactly those shapes and nothing else.
 *
 * Every renderer must be pure and produce deterministic, stable-ordered
 * output (task 6.6): this emitter never reorders keys (it walks
 * `Object.entries` in declaration order) and never depends on the clock or
 * the filesystem.
 */

export type YamlValue = string | boolean | readonly YamlValue[] | { readonly [key: string]: YamlValue };

/** YAML indicator characters that change meaning when they start a plain scalar. */
const LEADING_INDICATOR_RE = /^[-?:,[\]{}#&*!|>'"%@`]/;
const RESERVED_KEYWORD_RE = /^(true|false|yes|no|null|~)$/i;
const NUMBER_LIKE_RE = /^-?\d+(\.\d+)?$/;
/** A `#` preceded by whitespace starts a YAML comment in a plain scalar, silently truncating the rest of the line. */
const MID_STRING_COMMENT_RE = /[ \t]#/;
/** Any C0 control character (including `\n`, `\t`, `\r`) or DEL; none may appear unescaped in a plain scalar. */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
/** Same character class, `g`-flagged for `.replace()` (which resets `lastIndex` itself, unlike `.test()`). */
const CONTROL_CHAR_GLOBAL_RE = /[\x00-\x1f\x7f]/g;

function needsQuoting(value: string): boolean {
  if (value.length === 0) return true;
  if (/^\s|\s$/.test(value)) return true;
  if (CONTROL_CHAR_RE.test(value)) return true;
  if (MID_STRING_COMMENT_RE.test(value)) return true;
  if (LEADING_INDICATOR_RE.test(value)) return true;
  if (value.includes(": ") || value.endsWith(":")) return true;
  if (value.includes('"')) return true;
  if (RESERVED_KEYWORD_RE.test(value)) return true;
  if (NUMBER_LIKE_RE.test(value)) return true;
  return false;
}

/** Escapes one C0/DEL control character for a double-quoted YAML scalar: the three named escapes, else `\xHH`. */
function escapeControlChar(char: string): string {
  switch (char) {
    case "\n":
      return "\\n";
    case "\t":
      return "\\t";
    case "\r":
      return "\\r";
    default:
      return `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
  }
}

function renderYamlString(value: string): string {
  if (!needsQuoting(value)) return value;
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(CONTROL_CHAR_GLOBAL_RE, escapeControlChar);
  return `"${escaped}"`;
}

/** Mapping keys follow the same quoting rules as string scalars (e.g. `"*"`). */
function renderYamlKey(key: string): string {
  return renderYamlString(key);
}

function renderScalar(value: string | boolean): string {
  return typeof value === "boolean" ? String(value) : renderYamlString(value);
}

/**
 * Renders `value` for placement after `"key:"`. Returns either an inline
 * scalar (no leading newline) or a block that starts with `"\n"` and is
 * already indented for the next nesting level, so the caller only has to
 * decide whether to put a space or a newline after the colon.
 */
function renderValue(value: YamlValue, indentSpaces: number): string {
  if (typeof value === "string" || typeof value === "boolean") {
    return renderScalar(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return "\n" + value.map((item) => renderSequenceItem(item, indentSpaces)).join("\n");
  }
  const entries = Object.entries(value as { readonly [key: string]: YamlValue });
  if (entries.length === 0) return "{}";
  return "\n" + entries.map(([key, entryValue]) => renderKeyValue(key, entryValue, indentSpaces)).join("\n");
}

function renderSequenceItem(item: YamlValue, indentSpaces: number): string {
  const bullet = " ".repeat(indentSpaces) + "- ";
  if (typeof item === "string" || typeof item === "boolean") {
    return bullet + renderScalar(item);
  }
  if (Array.isArray(item)) {
    // None of the three renderers ever need a sequence nested directly
    // inside another sequence; fail loudly instead of silently emitting
    // ambiguous YAML if that ever changes.
    throw new Error("toFrontmatter: a sequence item that is itself a sequence is not supported");
  }
  const entries = Object.entries(item);
  return entries
    .map(([key, entryValue], index) => {
      const prefix = index === 0 ? bullet : " ".repeat(indentSpaces + 2);
      return renderKeyValue(key, entryValue, indentSpaces + 2, prefix);
    })
    .join("\n");
}

function renderKeyValue(key: string, value: YamlValue, indentSpaces: number, customPrefix?: string): string {
  const prefix = customPrefix ?? " ".repeat(indentSpaces);
  const rendered = renderValue(value, indentSpaces + 2);
  const separator = rendered.startsWith("\n") ? ":" : ": ";
  return `${prefix}${renderYamlKey(key)}${separator}${rendered}`;
}

/**
 * Renders a flat set of top-level frontmatter fields. A field whose value is
 * `undefined` is omitted entirely (rather than emitted as `null`), so a
 * renderer can pass an optional field unconditionally
 * (`{ ..., model: agent.model }`) without an `if` for every optional key.
 */
export function toFrontmatter(fields: Readonly<Record<string, YamlValue | undefined>>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    lines.push(renderKeyValue(key, value, 0));
  }
  return lines.join("\n");
}

/**
 * Wraps `toFrontmatter(fields)` in `---` delimiters followed by `body`,
 * normalized to end in exactly one LF newline (task 6.6: "trailing newline,
 * LF"), regardless of whether `body` itself already ends in one.
 */
export function renderFrontmatterFile(fields: Readonly<Record<string, YamlValue | undefined>>, body: string): string {
  const frontmatter = toFrontmatter(fields);
  const normalizedBody = body.replace(/\n+$/, "");
  return `---\n${frontmatter}\n---\n${normalizedBody}\n`;
}
