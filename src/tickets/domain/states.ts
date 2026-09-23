/**
 * Ticket state machine states. `Reopened` shares rank 1 with `Triaged`
 * (both are "re-entry into active handling" points); it is not on the
 * main forward path but the rank value must not collide with anything
 * strictly below `InProgress`.
 */
export type TicketState =
  | "New"
  | "Triaged"
  | "InProgress"
  | "PendingUserConfirmation"
  | "Escalated"
  | "Resolved"
  | "Closed"
  | "Reopened";

export const STATE_RANK: Readonly<Record<TicketState, number>> = {
  New: 0,
  Triaged: 1,
  Reopened: 1,
  InProgress: 2,
  PendingUserConfirmation: 3,
  Escalated: 4,
  Resolved: 5,
  Closed: 6,
} as const;
