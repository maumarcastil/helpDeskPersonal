/**
 * Nominal-typing helper. `Brand<string, 'TicketId'>` and `Brand<string,
 * 'TicketId2'>` are both structurally `string` but not assignable to each
 * other, so ids from different entities can't be swapped by accident.
 */
declare const brandTag: unique symbol;

export type Brand<T, TBrand extends string> = T & {
  readonly [brandTag]: TBrand;
};
