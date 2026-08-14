import { RequestStatus } from '../types';
import { ConflictError } from '../security/errors';

/**
 * Allowed job status transitions.
 *
 * A run that may have partially completed never returns to a runnable state on
 * its own: RUNNING can only move forward to COMPLETED, FAILED or
 * AUTHENTICATION_REQUIRED. Re-running requires a fresh request, which starts by
 * reading the current Readymode state.
 */
export const ALLOWED_TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  PENDING: ['NEEDS_INFORMATION', 'AWAITING_APPROVAL', 'APPROVED', 'RUNNING', 'CANCELLED', 'FAILED'],
  NEEDS_INFORMATION: ['PENDING', 'AWAITING_APPROVAL', 'CANCELLED', 'FAILED'],
  AWAITING_APPROVAL: ['APPROVED', 'CANCELLED', 'FAILED', 'NEEDS_INFORMATION'],
  APPROVED: ['RUNNING', 'CANCELLED', 'FAILED'],
  RUNNING: ['COMPLETED', 'FAILED', 'AUTHENTICATION_REQUIRED'],
  AUTHENTICATION_REQUIRED: ['CANCELLED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export const TERMINAL_STATUSES: ReadonlySet<RequestStatus> = new Set<RequestStatus>([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: RequestStatus, to: RequestStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictError(`A request cannot move from ${from} to ${to}.`);
  }
}

export function isTerminal(status: RequestStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Whether a failed run may be retried automatically. It may not: a browser
 * action that failed mid-flight might have partially applied, so the current
 * Readymode state has to be read again first.
 */
export function isAutomaticRetryAllowed(): boolean {
  return false;
}
