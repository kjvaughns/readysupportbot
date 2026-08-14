import { pingDatabase } from '../db/client.js';
import * as requests from '../db/repositories/requests.js';
import * as settings from '../db/repositories/settings.js';
import * as browserSessions from '../db/repositories/browserSessions.js';
import { getClient, getQueue, getReadymodeService, uptimeSeconds } from '../runtime.js';
import { moduleLogger } from '../util/logger.js';
import { minutes } from '../util/time.js';

/**
 * Health checks.
 *
 * Each one answers independently and never throws: a check that cannot run is
 * reported as failing rather than taking the endpoint down with it, because
 * the whole point of this is to be readable when things are going wrong.
 */

const log = moduleLogger('health');

export type CheckState = 'ok' | 'degraded' | 'failing' | 'unknown';

export interface CheckResult {
  name: string;
  state: CheckState;
  /** One line a human can act on. */
  detail: string;
  /** Extra structured facts for the /health payload. */
  data?: Record<string, unknown>;
}

export interface HealthReport {
  state: CheckState;
  uptimeSeconds: number;
  checkedAt: string;
  checks: CheckResult[];
}

async function safely(name: string, run: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await run();
  } catch (cause) {
    log.warn({ err: cause, check: name }, 'Health check threw');
    return {
      name,
      state: 'failing',
      detail: 'This check could not run.',
    };
  }
}

async function discordCheck(): Promise<CheckResult> {
  const client = getClient();
  if (!client) return { name: 'discord', state: 'unknown', detail: 'The Discord client has not started yet.' };

  const ready = client.isReady();
  const ping = Math.round(client.ws.ping);

  return {
    name: 'discord',
    state: ready ? 'ok' : 'failing',
    detail: ready ? `Connected as ${client.user?.tag ?? 'unknown'} (${ping}ms).` : 'Not connected to Discord.',
    data: { ready, pingMs: ping, guilds: client.guilds.cache.size },
  };
}

async function supabaseCheck(): Promise<CheckResult> {
  const result = await pingDatabase();
  return {
    name: 'supabase',
    state: result.ok ? 'ok' : 'failing',
    detail: result.ok
      ? `Reachable in ${result.latencyMs}ms.`
      : 'The database is not reachable. Nothing can be recorded or queued.',
    data: { latencyMs: result.latencyMs, ...(result.error ? { error: result.error } : {}) },
  };
}

/**
 * Browserbase liveness is inferred from the most recent session rather than by
 * opening a new one. Opening a browser to prove a browser can be opened costs
 * real money and, on a busy queue, would compete with actual work.
 */
async function browserCheck(): Promise<CheckResult> {
  const service = getReadymodeService();
  if (!service) {
    return { name: 'browserbase', state: 'unknown', detail: 'The Readymode driver has not started yet.' };
  }

  if (service.name === 'mock') {
    return {
      name: 'browserbase',
      state: 'ok',
      detail: 'Running against the in-memory mock; no browser is in use.',
      data: { driver: 'mock' },
    };
  }

  const recent = await browserSessions.findMostRecent();
  if (!recent) {
    return {
      name: 'browserbase',
      state: 'unknown',
      detail: 'No browser session has been opened yet.',
      data: { driver: 'live' },
    };
  }

  const failed = recent.status === 'FAILED';
  return {
    name: 'browserbase',
    state: failed ? 'degraded' : 'ok',
    detail: failed
      ? 'The most recent browser session failed.'
      : `Last session ${recent.status.toLowerCase()} at ${recent.ended_at ?? recent.started_at}.`,
    data: {
      driver: 'live',
      status: recent.status,
      startedAt: recent.started_at,
      performedLogin: recent.performed_login,
    },
  };
}

async function readymodeAuthCheck(): Promise<CheckResult> {
  const state = await settings.get('readymode_auth_state');

  const map: Record<typeof state.state, CheckState> = {
    AUTHENTICATED: 'ok',
    EXPIRED: 'failing',
    VERIFICATION_REQUIRED: 'failing',
    UNKNOWN: 'unknown',
  };

  const detail =
    state.state === 'AUTHENTICATED'
      ? 'Signed in to Readymode.'
      : state.state === 'VERIFICATION_REQUIRED'
        ? 'Readymode is asking for manual verification. An administrator has to sign in.'
        : state.state === 'EXPIRED'
          ? 'The Readymode session has expired. Run /reconnect_readymode.'
          : 'Readymode has not been checked since start-up.';

  return {
    name: 'readymode_auth',
    state: map[state.state],
    detail,
    data: { state: state.state, checkedAt: state.checkedAt },
  };
}

async function queueCheck(): Promise<CheckResult> {
  const queue = getQueue();
  const paused = await settings.get('queue_paused');
  const approved = await requests.countByStatus('APPROVED');
  const blocked = await requests.countByStatus('AUTHENTICATION_REQUIRED');

  const running = queue?.isRunning() ?? false;

  const state: CheckState = !running ? 'failing' : paused.paused ? 'degraded' : 'ok';

  return {
    name: 'queue',
    state,
    detail: !running
      ? 'The queue worker is not running.'
      : paused.paused
        ? `Held: ${paused.reason ?? 'no reason recorded'}. ${approved + blocked} request(s) waiting.`
        : `Running. ${approved} queued, ${blocked} waiting on Readymode access.`,
    data: {
      workerRunning: running,
      paused: paused.paused,
      pausedReason: paused.reason,
      queued: approved,
      blocked,
      currentJob: queue?.currentJob() ?? null,
    },
  };
}

async function lastSuccessCheck(): Promise<CheckResult> {
  const last = await settings.get('last_successful_automation');

  if (!last.at) {
    return {
      name: 'last_success',
      state: 'unknown',
      detail: 'Nothing has completed yet.',
    };
  }

  const ageMs = Date.now() - Date.parse(last.at);
  const stale = ageMs > minutes(24 * 60);

  return {
    name: 'last_success',
    state: stale ? 'degraded' : 'ok',
    detail: stale
      ? `The last successful action was more than a day ago (${last.action ?? 'unknown action'}).`
      : `Last success: ${last.action ?? 'unknown action'} at ${last.at}.`,
    data: { ...last, ageMinutes: Math.floor(ageMs / 60_000) },
  };
}

async function failureCheck(): Promise<CheckResult> {
  const consecutive = await settings.get('consecutive_failures');
  const sinceIso = new Date(Date.now() - minutes(60)).toISOString();
  const recent = await requests.countRecentFailures(sinceIso);

  const state: CheckState = consecutive.count >= 3 ? 'failing' : recent > 0 ? 'degraded' : 'ok';

  return {
    name: 'failures',
    state,
    detail:
      consecutive.count >= 3
        ? `${consecutive.count} workflows have failed in a row. Something systematic is likely wrong.`
        : `${recent} failure(s) in the last hour, ${consecutive.count} consecutive.`,
    data: { consecutive: consecutive.count, lastCategory: consecutive.lastCategory, lastHour: recent },
  };
}

const WORST_FIRST: CheckState[] = ['failing', 'degraded', 'unknown', 'ok'];

function worst(states: CheckState[]): CheckState {
  for (const candidate of WORST_FIRST) {
    if (states.includes(candidate)) return candidate;
  }
  return 'ok';
}

/** Run every check. Always resolves. */
export async function runHealthChecks(): Promise<HealthReport> {
  const checks = await Promise.all([
    safely('discord', discordCheck),
    safely('supabase', supabaseCheck),
    safely('browserbase', browserCheck),
    safely('readymode_auth', readymodeAuthCheck),
    safely('queue', queueCheck),
    safely('last_success', lastSuccessCheck),
    safely('failures', failureCheck),
  ]);

  return {
    state: worst(checks.map((check) => check.state)),
    uptimeSeconds: uptimeSeconds(),
    checkedAt: new Date().toISOString(),
    checks,
  };
}

/**
 * A cheaper probe for the container platform's liveness check: is the process
 * able to serve at all? A failing Readymode session is not a reason for the
 * platform to restart the container, so this deliberately ignores it.
 */
export async function runLivenessCheck(): Promise<{ ok: boolean; detail: string }> {
  const client = getClient();
  const database = await pingDatabase();

  if (!database.ok) return { ok: false, detail: 'The database is not reachable.' };
  if (!client?.isReady()) return { ok: false, detail: 'Not connected to Discord.' };
  return { ok: true, detail: 'Serving.' };
}
