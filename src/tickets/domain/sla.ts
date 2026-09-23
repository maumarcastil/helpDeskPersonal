import type { Priority } from "./ticket.js";

export interface SlaDuration {
  readonly amount: number;
  readonly unit: "hour" | "business-day";
}

export interface SlaSpec {
  readonly response: SlaDuration;
  readonly resolution: SlaDuration;
}

/**
 * Fixed response/resolution SLA per priority (spec `ticket-triage-priority`
 * -> Requirement "SLA Per Priority"). No scheduler or background process:
 * SLA is data shown to agents, anchored at `triagedAt` when a ticket is
 * actually triaged (see `computeSlaDueDates`).
 */
const SLA_TABLE: Readonly<Record<Priority, SlaSpec>> = {
  P1: {
    response: { amount: 1, unit: "hour" },
    resolution: { amount: 4, unit: "hour" },
  },
  P2: {
    response: { amount: 4, unit: "hour" },
    resolution: { amount: 1, unit: "business-day" },
  },
  P3: {
    response: { amount: 1, unit: "business-day" },
    resolution: { amount: 3, unit: "business-day" },
  },
};

export function computeSla(priority: Priority): SlaSpec {
  return SLA_TABLE[priority];
}

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6;
}

/**
 * Adds `days` business days to `start`, skipping Saturday/Sunday (UTC), no
 * holidays. Advances 24h at a time and only counts a step as consumed when
 * it lands on a weekday, so a start on a weekend correctly rolls forward
 * to the next Monday before the first business day is counted.
 */
export function addBusinessDays(start: Date, days: number): Date {
  let result = new Date(start.getTime());
  let remaining = days;
  while (remaining > 0) {
    result = new Date(result.getTime() + 24 * 60 * 60 * 1000);
    if (!isWeekend(result)) {
      remaining -= 1;
    }
  }
  return result;
}

function applyDuration(anchor: Date, duration: SlaDuration): Date {
  if (duration.unit === "hour") {
    return new Date(anchor.getTime() + duration.amount * 60 * 60 * 1000);
  }
  return addBusinessDays(anchor, duration.amount);
}

/** SLA due-at timestamps anchored at `anchor` (normally `triagedAt`). */
export function computeSlaDueDates(
  priority: Priority,
  anchor: Date,
): { responseDueAt: string; resolutionDueAt: string } {
  const spec = computeSla(priority);
  return {
    responseDueAt: applyDuration(anchor, spec.response).toISOString(),
    resolutionDueAt: applyDuration(anchor, spec.resolution).toISOString(),
  };
}
