import type { Clock } from "../../shared/ports/clock.js";

/**
 * Production `Clock` adapter (Phase 3, ADR 0013). Wraps the host's
 * `new Date()` so every domain/application function that asks for "now"
 * through a `Clock` port gets the real wall clock in production, while
 * tests can still substitute a fixed-time fake.
 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
