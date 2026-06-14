/**
 * WAIT_STATES — issue states that indicate the issue is waiting for an external
 * event and must not be picked up by the scheduler or retry machinery.
 *
 * These states are injected into the getCandidatesStmt NOT IN clause so waiting
 * issues are never re-dispatched until the external event moves them back to
 * a schedulable state (e.g. 'todo').
 */
export const WAIT_STATES = ["awaiting_plan", "blocked"] as const;
export type WaitState = (typeof WAIT_STATES)[number];
