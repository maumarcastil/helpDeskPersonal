/**
 * Discriminated-union result type used by every domain function and use
 * case instead of throwing. Keeps every rejection path visible in the
 * compiler and trivially testable (design decision: "Result type instead
 * of exceptions in domain/application").
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
