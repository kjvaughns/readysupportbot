import * as settings from '../db/repositories/settings.js';
import * as audit from '../audit/audit.js';
import { moduleLogger } from '../util/logger.js';
import { minutes } from '../util/time.js';

/**
 * Owner notifications.
 *
 * The Discord layer registers a delivery function at boot; everything else
 * calls `alert()`. Keeping the transport behind an interface means the queue,
 * the browser session and the health checks can raise an alert without any of
 * them importing the Discord client, and tests can assert on alerts without a
 * gateway connection.
 *
 * Each alert kind is rate limited by a dedupe window held in the database. An
 * expired Readymode session would otherwise produce one alert per queued job
 * and drown the channel it is trying to get attention in.
 */

const log = moduleLogger('notify');

export type AlertKind =
  | 'AUTH_EXPIRED'
  | 'AUTH_RESTORED'
  | 'VERIFICATION_REQUIRED'
  | 'CONSECUTIVE_FAILURES'
  | 'SELECTORS_BROKEN'
  | 'BROWSER_UNAVAILABLE'
  | 'UNAUTHORIZED_REQUEST'
  | 'HEALTH_DEGRADED';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  /** Plain-language body. Contains no selectors, stack traces or credentials. */
  message: string;
  /** Short labelled facts shown under the message. */
  facts?: Record<string, string>;
  /** Reference of the request that triggered this, when there is one. */
  reference?: number;
  requestId?: string;
}

export interface AlertSink {
  deliver(alert: Alert): Promise<void>;
}

/** How long the same alert kind stays quiet after being sent. */
const DEDUPE_WINDOW_MS: Record<AlertKind, number> = {
  AUTH_EXPIRED: minutes(15),
  AUTH_RESTORED: minutes(1),
  VERIFICATION_REQUIRED: minutes(15),
  CONSECUTIVE_FAILURES: minutes(30),
  SELECTORS_BROKEN: minutes(60),
  BROWSER_UNAVAILABLE: minutes(15),
  // Every unauthorized attempt is worth seeing; only identical repeats within
  // a minute are collapsed.
  UNAUTHORIZED_REQUEST: minutes(1),
  HEALTH_DEGRADED: minutes(30),
};

let sink: AlertSink | undefined;

export function registerAlertSink(replacement: AlertSink | undefined): void {
  sink = replacement;
}

/**
 * True when this kind is outside its dedupe window. Stamps the clock as a side
 * effect, so two callers racing produce one alert.
 */
async function shouldSend(kind: AlertKind, dedupeKey: string): Promise<boolean> {
  const state = await settings.get('alert_dedupe');
  const key = `${kind}:${dedupeKey}`;
  const last = state[key];

  if (last) {
    const elapsed = Date.now() - Date.parse(last);
    if (Number.isFinite(elapsed) && elapsed < DEDUPE_WINDOW_MS[kind]) return false;
  }

  await settings.set('alert_dedupe', { ...state, [key]: new Date().toISOString() });
  return true;
}

/**
 * Raise an alert. Always audited, even when suppressed by deduplication, so
 * the record shows the true frequency of a problem rather than how often
 * someone was told about it.
 */
export async function alert(
  input: Alert & { dedupeKey?: string; force?: boolean },
): Promise<void> {
  const { dedupeKey = 'default', force = false, ...payload } = input;

  await audit.recordSystemEvent('SYSTEM_ALERT', {
    requestId: payload.requestId ?? null,
    reference: payload.reference ?? null,
    errorMessage: payload.title,
    metadata: {
      kind: payload.kind,
      severity: payload.severity,
      message: payload.message,
      facts: payload.facts ?? {},
    },
  });

  try {
    if (!force && !(await shouldSend(payload.kind, dedupeKey))) {
      log.debug({ kind: payload.kind }, 'Alert suppressed inside its dedupe window');
      return;
    }
  } catch (cause) {
    // If the dedupe bookkeeping is broken, send the alert rather than swallow
    // it — a duplicate notification is a far smaller problem than silence.
    log.warn({ err: cause }, 'Could not read alert dedupe state; sending anyway');
  }

  if (!sink) {
    log.warn({ kind: payload.kind, title: payload.title }, 'No alert sink registered; alert not delivered');
    return;
  }

  try {
    await sink.deliver(payload);
  } catch (cause) {
    log.error({ err: cause, kind: payload.kind }, 'Could not deliver an alert');
  }
}

// ---------------------------------------------------------------------------
// The specific conditions the system alerts on
// ---------------------------------------------------------------------------

export async function alertAuthenticationExpired(detail?: string): Promise<void> {
  await alert({
    kind: 'AUTH_EXPIRED',
    severity: 'critical',
    title: 'ReadySupport has lost access to Readymode',
    message:
      'No queued changes will run until an administrator reconnects the account. ' +
      'Run /reconnect_readymode when you are ready to sign in again.',
    ...(detail ? { facts: { Detail: detail } } : {}),
  });
}

export async function alertVerificationRequired(detail?: string): Promise<void> {
  await alert({
    kind: 'VERIFICATION_REQUIRED',
    severity: 'critical',
    title: 'Readymode asked for extra verification',
    message:
      'Readymode presented a security check that ReadySupport is not permitted to complete. ' +
      'An administrator needs to sign in manually, then run /reconnect_readymode.',
    ...(detail ? { facts: { Detail: detail } } : {}),
  });
}

export async function alertAuthenticationRestored(): Promise<void> {
  await alert({
    kind: 'AUTH_RESTORED',
    severity: 'info',
    title: 'Readymode access restored',
    message: 'ReadySupport is signed in again. Queued work has resumed.',
  });
}

export async function alertConsecutiveFailures(count: number, lastError: string): Promise<void> {
  await alert({
    kind: 'CONSECUTIVE_FAILURES',
    severity: 'critical',
    title: `${count} workflows have failed in a row`,
    message:
      'Something systematic is likely wrong rather than one bad request. ' +
      'The queue is still running; check /login_status and the recent failures.',
    facts: { 'Most recent error': lastError },
  });
}

export async function alertSelectorsBroken(workflow: string, detail: string): Promise<void> {
  await alert({
    kind: 'SELECTORS_BROKEN',
    severity: 'critical',
    title: 'The Readymode interface no longer matches what ReadySupport expects',
    message:
      'A workflow stopped because a page did not look the way it should. Nothing was changed. ' +
      'The selectors probably need re-capturing with the discovery script.',
    facts: { Workflow: workflow, Detail: detail },
    dedupeKey: workflow,
  });
}

export async function alertBrowserUnavailable(detail: string): Promise<void> {
  await alert({
    kind: 'BROWSER_UNAVAILABLE',
    severity: 'critical',
    title: 'The browser service is unavailable',
    message:
      'ReadySupport cannot open a Readymode session right now. Queued work will wait rather than fail.',
    facts: { Detail: detail },
  });
}

export async function alertUnauthorizedRequest(input: {
  discordUserId: string;
  guildId: string | null;
  channelId: string;
  attempted: string;
  reason: string;
}): Promise<void> {
  await alert({
    kind: 'UNAUTHORIZED_REQUEST',
    severity: 'warning',
    title: 'An unauthorized request was refused',
    message: 'Someone who is not set up to use ReadySupport tried to run something.',
    facts: {
      User: `<@${input.discordUserId}>`,
      Server: input.guildId ?? 'direct message',
      Channel: `<#${input.channelId}>`,
      Attempted: input.attempted,
      Reason: input.reason,
    },
    dedupeKey: `${input.discordUserId}:${input.attempted}`,
  });
}
