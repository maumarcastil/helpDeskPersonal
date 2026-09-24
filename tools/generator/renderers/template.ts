/**
 * Rewrites a prompt's neutral `{{param}}` placeholders (ADR 0009) into a
 * platform's own variable syntax. Mirrors the shape of `PLACEHOLDER_RE` in
 * `tools/generator/definitions/schema.ts` (a valid placeholder is a single
 * `\w+` word) so a template that `validateModel` already accepted always
 * substitutes cleanly here — `validate.ts` (via `checkPromptTemplate`) is
 * what rejects a malformed `{{...}}` span before a renderer ever sees it.
 */
const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

export function substitutePlaceholders(template: string, replace: (name: string) => string): string {
  return template.replace(PLACEHOLDER_RE, (_match, name: string) => replace(name));
}
