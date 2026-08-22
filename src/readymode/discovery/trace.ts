/* eslint-disable no-console -- The workflow trace prints to stdout on purpose,
 * so a run that stops can be read in a raw log tail without a JSON viewer.
 * Every line is structural: state names, screen keys, URL paths, durations and
 * outcomes. No page text, no credentials, no personal data.
 */
import { sanitizePageValue } from '../../security/sanitize';

/**
 * Discovery as a finite-state workflow.
 *
 * The run used to be a sequence of awaits with no notion of where it was, so a
 * run that stopped told you nothing about where it stopped — and with no
 * overall budget, it could outlive Browserbase's own five-minute timeout, which
 * then became the error handler. A timeout from the platform says only that
 * something took too long.
 *
 * Every transition is named and timestamped, every screen attempt is recorded
 * with its duration and outcome, and the whole thing runs against a deadline it
 * owns.
 */

export const WORKFLOW_STATES = [
  'credentials_submitted',
  'session_warning_detected',
  'continue_clicked',
  'post_login_navigation_started',
  'authenticated_page_loaded',
  'dashboard_confirmed',
  'screen_discovery_started',
  'screen_discovery_finished',
  'profile_saved',
  'response_returned',
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export interface TraceEvent {
  at: string;
  /** Milliseconds since the run began. */
  elapsedMs: number;
  state?: WorkflowState;
  /** For per-screen events. */
  screen?: string;
  frame?: string;
  /** Path only — a query string can carry a token. */
  path?: string;
  result?: 'confirmed' | 'inspected' | 'skipped' | 'failed' | 'timeout';
  durationMs?: number;
  detail?: string;
}

/** What a run reports about itself when it ends, however it ends. */
export interface WorkflowReport {
  state: WorkflowState | null;
  lastSuccessfulState: WorkflowState | null;
  /** The operation in flight when it stopped, when it stopped badly. */
  failingOperation: string | null;
  errorClass: string | null;
  errorMessage: string | null;
  events: TraceEvent[];
  totalMs: number;
  screensAttempted: number;
  screensConfirmed: number;
  screensSkipped: number;
  screensFailed: number;
}

export class DiscoveryTrace {
  private readonly startedAt = Date.now();

  private readonly entries: TraceEvent[] = [];

  private current: WorkflowState | null = null;

  private lastSuccessful: WorkflowState | null = null;

  private failing: string | null = null;

  private errorClass: string | null = null;

  private errorMessage: string | null = null;

  readonly screens = { attempted: 0, confirmed: 0, skipped: 0, failed: 0 };

  elapsed(): number {
    return Date.now() - this.startedAt;
  }

  /** Records a transition. Reaching a state is itself the success of the last. */
  enter(state: WorkflowState, detail?: string): void {
    this.current = state;
    this.lastSuccessful = state;
    this.push({ state, detail });
    console.log(`[Readymode Discovery] ${state}${detail ? ` — ${detail}` : ''} +${this.elapsed()}ms`);
  }

  /** One navigation attempt, whatever came of it. */
  screen(input: {
    screen: string;
    frame?: string;
    path?: string;
    result: NonNullable<TraceEvent['result']>;
    durationMs: number;
    detail?: string;
  }): void {
    this.screens.attempted += 1;
    if (input.result === 'confirmed') this.screens.confirmed += 1;
    if (input.result === 'skipped') this.screens.skipped += 1;
    if (input.result === 'failed' || input.result === 'timeout') this.screens.failed += 1;

    this.push(input);
    console.log(
      `[Readymode Discovery] screen ${input.screen} ${input.result} ` +
        `path=${input.path ?? '?'} frame=${input.frame ?? 'main document'} ${input.durationMs}ms`,
    );
  }

  /** The operation that was in flight when the run stopped badly. */
  fail(operation: string, error: unknown): void {
    this.failing = operation;
    this.errorClass = error instanceof Error ? error.constructor.name : typeof error;
    this.errorMessage = sanitizePageValue(
      error instanceof Error ? error.message : String(error ?? 'unknown'),
      300,
    );
    this.push({ detail: `failed during ${operation}: ${this.errorMessage}` });
    console.log(
      `[Readymode Discovery] FAILED during ${operation} (${this.errorClass}) +${this.elapsed()}ms`,
    );
  }

  note(detail: string): void {
    this.push({ detail });
    console.log(`[Readymode Discovery] ${detail} +${this.elapsed()}ms`);
  }

  report(): WorkflowReport {
    return {
      state: this.current,
      lastSuccessfulState: this.lastSuccessful,
      failingOperation: this.failing,
      errorClass: this.errorClass,
      errorMessage: this.errorMessage,
      events: this.entries,
      totalMs: this.elapsed(),
      screensAttempted: this.screens.attempted,
      screensConfirmed: this.screens.confirmed,
      screensSkipped: this.screens.skipped,
      screensFailed: this.screens.failed,
    };
  }

  private push(partial: Omit<TraceEvent, 'at' | 'elapsedMs'>): void {
    this.entries.push({ at: new Date().toISOString(), elapsedMs: this.elapsed(), ...partial });
  }
}

/**
 * A budget the run owns, rather than one the platform imposes.
 *
 * Browserbase stops a session after five minutes. If discovery can run longer
 * than that, the platform's timeout becomes the error handler — and it reports
 * only that something took too long, never which screen or why.
 */
export class Deadline {
  private readonly endsAt: number;

  constructor(totalMs: number) {
    this.endsAt = Date.now() + totalMs;
  }

  remaining(): number {
    return Math.max(0, this.endsAt - Date.now());
  }

  expired(): boolean {
    return this.remaining() <= 0;
  }

  /** The smaller of what was asked for and what is left. */
  slice(preferredMs: number): number {
    return Math.max(0, Math.min(preferredMs, this.remaining()));
  }
}

export interface TimedResult<T> {
  ok: boolean;
  value?: T;
  timedOut: boolean;
  error?: unknown;
  durationMs: number;
}

/**
 * Runs one operation under a hard limit.
 *
 * Playwright's own timeouts cover a locator or a navigation, but not "everything
 * this screen needs" — so a screen could spend a minute across a dozen calls
 * that each finished inside their own limit. This bounds the whole operation.
 *
 * A timeout is returned, never thrown: one screen taking too long is a fact
 * about that screen, and stopping the crawl over it loses every screen after it.
 */
export async function withTimeout<T>(
  operation: string,
  ms: number,
  run: () => Promise<T>,
): Promise<TimedResult<T>> {
  const started = Date.now();

  if (ms <= 0) {
    return { ok: false, timedOut: true, durationMs: 0, error: new Error(`${operation}: no time left`) };
  }

  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });

  try {
    const outcome = await Promise.race([run().then((value) => ({ value })), expiry]);

    if (outcome === 'timeout') {
      return {
        ok: false,
        timedOut: true,
        durationMs: Date.now() - started,
        error: new Error(`${operation} exceeded ${ms}ms`),
      };
    }

    return { ok: true, value: outcome.value, timedOut: false, durationMs: Date.now() - started };
  } catch (error) {
    return { ok: false, timedOut: false, error, durationMs: Date.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Limits, in one place so they can be read against Browserbase's own. */
export const DISCOVERY_LIMITS = {
  /** The whole run. Comfortably inside Browserbase's five minutes. */
  totalMs: 240_000,
  /** The reduced run: login, confirm, read the navigation, save. */
  reducedTotalMs: 90_000,
  /** Any one screen. */
  perScreenMs: 20_000,
  settleMs: 8_000,
  confirmMs: 20_000,
  screenshotMs: 5_000,
  saveMs: 15_000,
} as const;
