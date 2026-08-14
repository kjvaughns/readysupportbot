import * as requests from '../db/repositories/requests.js';
import * as settings from '../db/repositories/settings.js';
import * as approvals from '../approvals/service.js';
import type { AutomationRequestRow } from '../db/types.js';
import type { ReadymodeService } from '../readymode/port.js';
import { moduleLogger } from '../util/logger.js';
import { sleep } from '../util/time.js';
import { execute, type ExecutionOutcome } from './executor.js';

/**
 * The job queue.
 *
 * Strictly sequential: exactly one browser workflow runs at a time. That is
 * not a throughput compromise, it is the point. All jobs share a single
 * persistent Browserbase context, and two workflows navigating the same
 * context concurrently would interleave clicks on the same pages.
 *
 * The queue is backed by the database rather than an in-process array, so a
 * restart loses nothing: pending and approved requests are still there, and
 * the worker picks them up again.
 */

const log = moduleLogger('queue');

/** Where a finished job's outcome is reported. Registered by the Discord layer. */
export interface OutcomeSink {
  deliver(outcome: ExecutionOutcome): Promise<void>;
}

export interface QueueOptions {
  service: ReadymodeService;
  sink?: OutcomeSink;
  /** How long to wait when there is nothing to do. */
  idleDelayMs?: number;
  /** How long to wait after an unexpected loop error. */
  errorDelayMs?: number;
}

export class JobQueue {
  private running = false;
  private stopping = false;
  private loopPromise: Promise<void> | undefined;
  private currentRequestId: string | undefined;

  private readonly service: ReadymodeService;
  private sink: OutcomeSink | undefined;
  private readonly idleDelayMs: number;
  private readonly errorDelayMs: number;

  constructor(options: QueueOptions) {
    this.service = options.service;
    this.sink = options.sink;
    this.idleDelayMs = options.idleDelayMs ?? 2_000;
    this.errorDelayMs = options.errorDelayMs ?? 10_000;
  }

  setSink(sink: OutcomeSink | undefined): void {
    this.sink = sink;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** The request currently executing, if any. Used by the health view. */
  currentJob(): string | undefined {
    return this.currentRequestId;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.loopPromise = this.loop();
    log.info('Job queue started');
  }

  /**
   * Stop claiming new work and wait for the job in flight to finish.
   *
   * A workflow is never interrupted mid-run: abandoning one halfway is exactly
   * how Readymode ends up in a state nobody can account for.
   */
  async stop(timeoutMs = 60_000): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    log.info({ current: this.currentRequestId }, 'Job queue stopping; waiting for the current job');

    const deadline = Date.now() + timeoutMs;
    while (this.loopPromise && Date.now() < deadline) {
      const finished = await Promise.race([
        this.loopPromise.then(() => true),
        sleep(250).then(() => false),
      ]);
      if (finished) break;
    }

    this.running = false;
    log.info('Job queue stopped');
  }

  /**
   * Run exactly one job if one is available. Returns the outcome, or null when
   * the queue was empty, paused, or the claim was lost to another worker.
   * Exposed for tests and for the single-shot path in the health check.
   */
  async tick(): Promise<ExecutionOutcome | null> {
    await approvals.sweepExpired();

    let claimed: AutomationRequestRow | null;
    try {
      claimed = await requests.claimNext();
    } catch (cause) {
      log.error({ err: cause }, 'Could not claim a request');
      return null;
    }

    if (!claimed) return null;

    this.currentRequestId = claimed.id;
    log.info(
      { requestId: claimed.id, reference: claimed.reference, action: claimed.action },
      'Running queued request',
    );

    try {
      const outcome = await execute(claimed, this.service);
      await this.report(outcome);
      return outcome;
    } finally {
      this.currentRequestId = undefined;
    }
  }

  /**
   * Report the outcome. A delivery failure is logged and swallowed: the job
   * itself already happened and its record is already written, and throwing
   * here would only stop the queue.
   */
  private async report(outcome: ExecutionOutcome): Promise<void> {
    if (!this.sink) {
      log.warn({ requestId: outcome.request.id }, 'No outcome sink registered; result not delivered');
      return;
    }
    try {
      await this.sink.deliver(outcome);
    } catch (cause) {
      log.error({ err: cause, requestId: outcome.request.id }, 'Could not deliver a job outcome');
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        const outcome = await this.tick();
        if (!outcome) {
          await sleep(this.idleDelayMs);
        }
      } catch (cause) {
        // execute() classifies its own failures, so reaching here means
        // something outside a job went wrong. Back off rather than spin.
        log.error({ err: cause }, 'Queue loop error');
        await sleep(this.errorDelayMs);
      }
    }
  }
}

/**
 * Boot-time recovery.
 *
 * Two things need attention after a restart:
 *
 *  - requests stranded in RUNNING. These are failed, never re-queued. The
 *    process died at an unknown point and the action may have partially
 *    completed; a human confirms the live state before anything is retried.
 *  - approvals whose window closed while the process was down.
 *
 * Approved-but-not-started work needs nothing: it is still APPROVED and the
 * worker will claim it.
 */
export async function recoverAfterRestart(): Promise<{
  quarantined: number;
  expired: number;
  queued: number;
  paused: boolean;
}> {
  const quarantined = await requests.quarantineInterrupted();
  if (quarantined > 0) {
    log.warn(
      { quarantined },
      'Requests were interrupted by a restart and have been failed for manual review, not retried',
    );
  }

  const expired = await approvals.sweepExpired();
  const queued = await requests.countByStatus('APPROVED');
  const paused = await settings.isQueuePaused();

  log.info({ quarantined, expired, queued, paused }, 'Queue recovery complete');
  return { quarantined, expired, queued, paused };
}

/**
 * Release the hold placed on the queue by an expired session, and put the
 * requests that were parked back in line.
 */
export async function resumeAfterReconnect(): Promise<number> {
  await settings.resumeQueue();
  await settings.set('readymode_auth_state', {
    state: 'AUTHENTICATED',
    checkedAt: new Date().toISOString(),
    detail: null,
  });

  const blocked = await requests.listBlockedOnAuthentication();
  let resumed = 0;

  for (const request of blocked) {
    try {
      await requests.update(request.id, { status: 'APPROVED' }, 'AUTHENTICATION_REQUIRED');
      resumed += 1;
    } catch (cause) {
      log.warn({ err: cause, requestId: request.id }, 'Could not re-queue a parked request');
    }
  }

  log.info({ resumed }, 'Resumed work that was waiting on Readymode access');
  return resumed;
}
