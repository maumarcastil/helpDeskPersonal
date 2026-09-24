/**
 * Port for reading the current time. Every domain/application function
 * that needs "now" takes a Clock instead of calling `new Date()`/`Date.now()`
 * directly, so tests can supply a fixed instant.
 */
export interface Clock {
  now(): Date;
}
