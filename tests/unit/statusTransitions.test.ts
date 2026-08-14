import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  InvalidStatusTransitionError,
  isTerminal,
  nextStatuses,
  REQUEST_STATUSES,
  STATUS_LABELS,
  type RequestStatus,
} from '../../src/domain/status.js';

describe('the request state machine', () => {
  it('walks the ordinary path for a mutating request', () => {
    const path: RequestStatus[] = ['PENDING', 'AWAITING_APPROVAL', 'APPROVED', 'RUNNING', 'COMPLETED'];

    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransition(path[index] as RequestStatus, path[index + 1] as RequestStatus)).toBe(true);
    }
  });

  it('lets a read-only request skip straight to APPROVED', () => {
    expect(canTransition('PENDING', 'APPROVED')).toBe(true);
  });

  it('never moves a running job back into the queue', () => {
    // A job interrupted mid-flight may have partially completed. Re-queueing
    // it would be the single most dangerous thing this system could do.
    expect(canTransition('RUNNING', 'APPROVED')).toBe(false);
    expect(canTransition('RUNNING', 'PENDING')).toBe(false);
    expect(canTransition('RUNNING', 'AWAITING_APPROVAL')).toBe(false);
  });

  it('sends an interrupted job to FAILED', () => {
    expect(canTransition('RUNNING', 'FAILED')).toBe(true);
  });

  it('parks work when Readymode access is lost, and releases it afterwards', () => {
    expect(canTransition('RUNNING', 'AUTHENTICATION_REQUIRED')).toBe(true);
    expect(canTransition('APPROVED', 'AUTHENTICATION_REQUIRED')).toBe(true);
    expect(canTransition('AUTHENTICATION_REQUIRED', 'APPROVED')).toBe(true);
  });

  it('treats COMPLETED, FAILED and CANCELLED as final', () => {
    for (const status of ['COMPLETED', 'FAILED', 'CANCELLED'] as const) {
      expect(isTerminal(status)).toBe(true);
      expect(nextStatuses(status)).toHaveLength(0);

      for (const target of REQUEST_STATUSES) {
        expect(canTransition(status, target)).toBe(false);
      }
    }
  });

  it('will not approve something that was never up for approval', () => {
    expect(canTransition('COMPLETED', 'APPROVED')).toBe(false);
    expect(canTransition('CANCELLED', 'RUNNING')).toBe(false);
  });

  it('only reaches RUNNING from APPROVED', () => {
    const sources = REQUEST_STATUSES.filter((status) => canTransition(status, 'RUNNING'));
    expect(sources).toEqual(['APPROVED']);
  });

  it('throws a readable error on an illegal transition', () => {
    expect(() => assertTransition('COMPLETED', 'RUNNING', 'req-1')).toThrow(InvalidStatusTransitionError);

    try {
      assertTransition('COMPLETED', 'RUNNING', 'req-1');
    } catch (error) {
      expect((error as Error).message).toContain('req-1');
      expect((error as Error).message).toContain('terminal state');
    }
  });

  it('gives every status a human label', () => {
    for (const status of REQUEST_STATUSES) {
      expect(STATUS_LABELS[status]).toBeTruthy();
    }
  });
});
