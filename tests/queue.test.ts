import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  JobQueue,
  assertTransition,
  canTransition,
  isAutomaticRetryAllowed,
  isTerminal,
  laneKey,
} from '../src/queue';
import { REQUEST_STATUSES } from '../src/types';
import { ConflictError } from '../src/security/errors';

describe('job status transitions', () => {
  it('defines a transition list for every status', () => {
    for (const status of REQUEST_STATUSES) {
      expect(ALLOWED_TRANSITIONS).toHaveProperty(status);
    }
  });

  it('follows the normal path', () => {
    expect(canTransition('PENDING', 'AWAITING_APPROVAL')).toBe(true);
    expect(canTransition('AWAITING_APPROVAL', 'APPROVED')).toBe(true);
    expect(canTransition('APPROVED', 'RUNNING')).toBe(true);
    expect(canTransition('RUNNING', 'COMPLETED')).toBe(true);
  });

  it('never lets a running job go back to a runnable state', () => {
    expect(canTransition('RUNNING', 'PENDING')).toBe(false);
    expect(canTransition('RUNNING', 'APPROVED')).toBe(false);
    expect(canTransition('RUNNING', 'RUNNING')).toBe(false);
    expect(canTransition('FAILED', 'RUNNING')).toBe(false);
  });

  it('treats completed, failed and cancelled as final', () => {
    expect(isTerminal('COMPLETED')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(isTerminal('RUNNING')).toBe(false);
    for (const status of ['COMPLETED', 'FAILED', 'CANCELLED'] as const) {
      expect(ALLOWED_TRANSITIONS[status]).toEqual([]);
    }
  });

  it('allows a run to stop for human verification', () => {
    expect(canTransition('RUNNING', 'AUTHENTICATION_REQUIRED')).toBe(true);
    expect(canTransition('AUTHENTICATION_REQUIRED', 'RUNNING')).toBe(false);
  });

  it('throws on an illegal transition', () => {
    expect(() => assertTransition('COMPLETED', 'RUNNING')).toThrowError(ConflictError);
    expect(() => assertTransition('PENDING', 'RUNNING')).not.toThrow();
  });

  it('never retries a possibly partial action automatically', () => {
    expect(isAutomaticRetryAllowed()).toBe(false);
  });
});

describe('serial job queue', () => {
  it('runs one job at a time per Readymode account', async () => {
    const queue = new JobQueue();
    const order: string[] = [];
    let concurrent = 0;
    let peak = 0;

    const job = (name: string, ms: number) => async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(name);
      concurrent -= 1;
      return name;
    };

    const key = laneKey('org-1');
    const results = await Promise.all([
      queue.enqueue(key, '1', job('first', 30)),
      queue.enqueue(key, '2', job('second', 5)),
      queue.enqueue(key, '3', job('third', 1)),
    ]);

    expect(peak).toBe(1);
    expect(order).toEqual(['first', 'second', 'third']);
    expect(results).toEqual(['first', 'second', 'third']);
  });

  it('keeps separate organizations independent', async () => {
    const queue = new JobQueue();
    let concurrent = 0;
    let peak = 0;

    const job = async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent -= 1;
    };

    await Promise.all([
      queue.enqueue(laneKey('org-1'), 'a', job),
      queue.enqueue(laneKey('org-2'), 'b', job),
    ]);

    expect(peak).toBe(2);
  });

  it('surfaces a failure without stopping the lane', async () => {
    const queue = new JobQueue();
    const key = laneKey('org-3');

    await expect(
      queue.enqueue(key, 'bad', async () => {
        throw new Error('workflow failed');
      }),
    ).rejects.toThrow('workflow failed');

    await expect(queue.enqueue(key, 'good', async () => 'ok')).resolves.toBe('ok');
  });

  it('holds queued work while a lane is paused', async () => {
    const queue = new JobQueue();
    const key = laneKey('org-4');
    let ran = false;

    queue.pause(key, 'Readymode requires human verification.');
    expect(queue.isPaused(key)).toBe(true);
    expect(queue.pauseReason(key)).toMatch(/human verification/);

    const pending = queue.enqueue(key, 'held', async () => {
      ran = true;
      return 'done';
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ran).toBe(false);
    expect(queue.depth(key)).toBe(1);

    queue.resume(key);
    await expect(pending).resolves.toBe('done');
    expect(ran).toBe(true);
  });

  it('reports a snapshot for the readiness endpoint', async () => {
    const queue = new JobQueue();
    queue.pause(laneKey('org-5'), 'paused for a test');
    const snapshot = queue.snapshot();
    expect(snapshot.paused).toHaveLength(1);
    expect(snapshot.lanes).toBe(1);
  });
});
