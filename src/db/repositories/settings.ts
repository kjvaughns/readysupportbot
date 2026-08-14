import { db, unwrap, unwrapMaybe } from '../client.js';
import type { SystemSettingRow, SystemSettingKey, SystemSettings } from '../types.js';

/**
 * Typed access to the system_settings key/value table.
 *
 * These are the few pieces of state the whole system consults: whether
 * Readymode is signed in, whether the queue is held, how many workflows have
 * failed in a row. Keeping them in the database rather than in memory means a
 * redeploy does not silently resume a queue that a human deliberately paused.
 */

const TABLE = 'system_settings';

const DEFAULTS: SystemSettings = {
  readymode_auth_state: { state: 'UNKNOWN', checkedAt: null, detail: null },
  queue_paused: { paused: false, reason: null, pausedBy: null, pausedAt: null },
  consecutive_failures: { count: 0, lastCategory: null, lastAt: null },
  last_successful_automation: { at: null, action: null, reference: null },
  alert_dedupe: {},
  readymode_vocabulary: {
    roles: [],
    licenseTypes: [],
    teams: [],
    campaigns: [],
    queues: [],
    capturedAt: null,
  },
};

export async function get<K extends SystemSettingKey>(key: K): Promise<SystemSettings[K]> {
  const row = unwrapMaybe<Pick<SystemSettingRow, 'value'>>(
    await db().from(TABLE).select('value').eq('key', key).maybeSingle(),
    `settings.get(${key})`,
  );

  if (!row) return DEFAULTS[key];
  return { ...DEFAULTS[key], ...(row.value as SystemSettings[K]) };
}

export async function set<K extends SystemSettingKey>(
  key: K,
  value: SystemSettings[K],
  updatedBy?: string,
): Promise<void> {
  unwrap<SystemSettingRow[]>(
    await db()
      .from(TABLE)
      .upsert(
        { key, value: value as unknown as Record<string, unknown>, updated_by: updatedBy ?? null },
        { onConflict: 'key' },
      )
      .select('key'),
    `settings.set(${key})`,
  );
}

/** Read-modify-write. Callers are the single queue worker, so no CAS is needed. */
export async function patch<K extends SystemSettingKey>(
  key: K,
  changes: Partial<SystemSettings[K]>,
  updatedBy?: string,
): Promise<SystemSettings[K]> {
  const current = await get(key);
  const next = { ...current, ...changes };
  await set(key, next, updatedBy);
  return next;
}

// ---------------------------------------------------------------------------
// Convenience accessors for the values consulted most often
// ---------------------------------------------------------------------------

export async function isQueuePaused(): Promise<boolean> {
  return (await get('queue_paused')).paused;
}

export async function pauseQueue(reason: string, pausedBy: string): Promise<void> {
  await set('queue_paused', {
    paused: true,
    reason,
    pausedBy,
    pausedAt: new Date().toISOString(),
  });
}

export async function resumeQueue(): Promise<void> {
  await set('queue_paused', { paused: false, reason: null, pausedBy: null, pausedAt: null });
}

export async function recordFailure(category: SystemSettings['consecutive_failures']['lastCategory']): Promise<number> {
  const current = await get('consecutive_failures');
  const next = {
    count: current.count + 1,
    lastCategory: category,
    lastAt: new Date().toISOString(),
  };
  await set('consecutive_failures', next);
  return next.count;
}

export async function recordSuccess(
  action: SystemSettings['last_successful_automation']['action'],
  reference: number,
): Promise<void> {
  await set('consecutive_failures', { count: 0, lastCategory: null, lastAt: null });
  await set('last_successful_automation', {
    at: new Date().toISOString(),
    action,
    reference,
  });
}
