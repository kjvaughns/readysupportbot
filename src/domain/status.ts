import { z } from 'zod';

/**
 * The lifecycle of an automation request.
 *
 * Transitions are explicit rather than implied so that a restart, a late
 * button click, or a duplicate worker can never move a request somewhere it
 * should not go. Every write to automation_requests.status goes through
 * assertTransition().
 */
export const REQUEST_STATUSES = [
  'PENDING',
  'AWAITING_INFORMATION',
  'AWAITING_APPROVAL',
  'APPROVED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'AUTHENTICATION_REQUIRED',
] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const requestStatusSchema = z.enum(REQUEST_STATUSES);

/** Statuses from which nothing further happens automatically. */
export const TERMINAL_STATUSES: ReadonlySet<RequestStatus> = new Set<RequestStatus>([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

export function isTerminal(status: RequestStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Allowed next states.
 *
 * Notable rules encoded here:
 *  - AUTHENTICATION_REQUIRED can go back to APPROVED once an administrator
 *    reconnects Readymode, so queued work resumes rather than being lost.
 *  - RUNNING never returns to APPROVED. A job interrupted mid-flight may have
 *    partially completed, so it goes to FAILED and a human verifies Readymode
 *    state before anything is retried.
 *  - Terminal states have no outgoing transitions at all.
 */
const TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  PENDING: ['AWAITING_INFORMATION', 'AWAITING_APPROVAL', 'APPROVED', 'FAILED', 'CANCELLED'],
  AWAITING_INFORMATION: ['PENDING', 'AWAITING_APPROVAL', 'APPROVED', 'CANCELLED', 'FAILED'],
  AWAITING_APPROVAL: ['APPROVED', 'CANCELLED', 'FAILED'],
  APPROVED: ['RUNNING', 'CANCELLED', 'FAILED', 'AUTHENTICATION_REQUIRED'],
  RUNNING: ['COMPLETED', 'FAILED', 'AUTHENTICATION_REQUIRED'],
  AUTHENTICATION_REQUIRED: ['APPROVED', 'CANCELLED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function nextStatuses(from: RequestStatus): readonly RequestStatus[] {
  return TRANSITIONS[from];
}

export class InvalidStatusTransitionError extends Error {
  constructor(
    readonly from: RequestStatus,
    readonly to: RequestStatus,
    readonly requestId?: string,
  ) {
    super(
      `Cannot move request${requestId ? ` ${requestId}` : ''} from ${from} to ${to}. ` +
        `Allowed: ${TRANSITIONS[from].join(', ') || 'none (terminal state)'}`,
    );
    this.name = 'InvalidStatusTransitionError';
  }
}

export function assertTransition(
  from: RequestStatus,
  to: RequestStatus,
  requestId?: string,
): void {
  if (!canTransition(from, to)) {
    throw new InvalidStatusTransitionError(from, to, requestId);
  }
}

/** Wording used in Discord embeds. */
export const STATUS_LABELS: Record<RequestStatus, string> = {
  PENDING: 'Pending',
  AWAITING_INFORMATION: 'Waiting for more information',
  AWAITING_APPROVAL: 'Waiting for approval',
  APPROVED: 'Approved and queued',
  RUNNING: 'Running',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  AUTHENTICATION_REQUIRED: 'Paused, Readymode sign-in required',
};
