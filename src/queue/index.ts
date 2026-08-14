import { logger } from '../security/logger';

export * from './statusMachine';

export interface QueuedJob<T = unknown> {
  id: string;
  key: string;
  run: () => Promise<T>;
  enqueuedAt: number;
}

interface Lane {
  running: boolean;
  paused: boolean;
  pauseReason?: string;
  queue: Array<{ job: QueuedJob<any>; resolve: (value: any) => void; reject: (error: unknown) => void }>;
}

/**
 * Serial job queue.
 *
 * Browser work runs one job at a time per Readymode account: a lane is keyed by
 * the connection, so two organizations progress in parallel while a single
 * organization never has two browser sessions touching the same account.
 *
 * A lane can be paused — that is what happens when Readymode asks for human
 * verification. Queued work stays queued until an Owner reconnects.
 */
export class JobQueue {
  private lanes = new Map<string, Lane>();

  private lane(key: string): Lane {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { running: false, paused: false, queue: [] };
      this.lanes.set(key, lane);
    }
    return lane;
  }

  enqueue<T>(key: string, id: string, run: () => Promise<T>): Promise<T> {
    const lane = this.lane(key);
    const job: QueuedJob<T> = { id, key, run, enqueuedAt: Date.now() };

    return new Promise<T>((resolve, reject) => {
      lane.queue.push({ job, resolve, reject });
      void this.drain(key);
    });
  }

  private async drain(key: string): Promise<void> {
    const lane = this.lane(key);
    if (lane.running || lane.paused) return;

    const next = lane.queue.shift();
    if (!next) return;

    lane.running = true;
    try {
      const result = await next.job.run();
      next.resolve(result);
    } catch (error) {
      // Failures are never retried automatically; the caller decides.
      logger.warn({ err: error, jobId: next.job.id, lane: key }, 'Queued job failed');
      next.reject(error);
    } finally {
      lane.running = false;
      // Yield so a paused lane observed during the job takes effect.
      setImmediate(() => void this.drain(key));
    }
  }

  /** Stops a lane. Used when Readymode requires human verification. */
  pause(key: string, reason: string): void {
    const lane = this.lane(key);
    lane.paused = true;
    lane.pauseReason = reason;
    logger.warn({ lane: key, reason }, 'Queue lane paused');
  }

  resume(key: string): void {
    const lane = this.lane(key);
    lane.paused = false;
    lane.pauseReason = undefined;
    logger.info({ lane: key }, 'Queue lane resumed');
    void this.drain(key);
  }

  isPaused(key: string): boolean {
    return this.lane(key).paused;
  }

  pauseReason(key: string): string | undefined {
    return this.lane(key).pauseReason;
  }

  depth(key: string): number {
    const lane = this.lanes.get(key);
    return lane ? lane.queue.length + (lane.running ? 1 : 0) : 0;
  }

  /** Snapshot used by the readiness endpoint. */
  snapshot(): {
    lanes: number;
    queued: number;
    running: number;
    paused: Array<{ key: string; reason?: string }>;
  } {
    let queued = 0;
    let running = 0;
    const paused: Array<{ key: string; reason?: string }> = [];

    for (const [key, lane] of this.lanes) {
      queued += lane.queue.length;
      if (lane.running) running += 1;
      if (lane.paused) paused.push({ key, reason: lane.pauseReason });
    }

    return { lanes: this.lanes.size, queued, running, paused };
  }

  clear(): void {
    for (const [, lane] of this.lanes) {
      for (const entry of lane.queue) {
        entry.reject(new Error('Queue cleared.'));
      }
      lane.queue = [];
    }
    this.lanes.clear();
  }
}

export const jobQueue = new JobQueue();

/** Lane key for an organization's Readymode account. */
export function laneKey(organizationId: string): string {
  return `readymode:${organizationId}`;
}
