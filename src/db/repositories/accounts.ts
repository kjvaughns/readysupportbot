import { db, unwrap, unwrapMaybe } from '../client.js';
import { sanitizeForAudit } from '../../security/redact.js';
import type { ReadymodeAccountRow } from '../types.js';

/**
 * The observed-account cache.
 *
 * Used to resolve a reference to a candidate list and to remember which
 * account a completed request touched. Nothing here is trusted for a decision:
 * every workflow re-reads live Readymode state before acting.
 */

const TABLE = 'readymode_accounts';

export async function findById(id: string): Promise<ReadymodeAccountRow | null> {
  return unwrapMaybe<ReadymodeAccountRow>(
    await db().from(TABLE).select('*').eq('id', id).maybeSingle(),
    'accounts.findById',
  );
}

export async function findByReadymodeUserId(userId: string): Promise<ReadymodeAccountRow | null> {
  return unwrapMaybe<ReadymodeAccountRow>(
    await db().from(TABLE).select('*').eq('readymode_user_id', userId).maybeSingle(),
    'accounts.findByReadymodeUserId',
  );
}

export async function findByUsername(username: string): Promise<ReadymodeAccountRow | null> {
  return unwrapMaybe<ReadymodeAccountRow>(
    await db().from(TABLE).select('*').ilike('username', username).maybeSingle(),
    'accounts.findByUsername',
  );
}

export async function findByEmail(email: string): Promise<ReadymodeAccountRow | null> {
  return unwrapMaybe<ReadymodeAccountRow>(
    await db().from(TABLE).select('*').ilike('email', email).maybeSingle(),
    'accounts.findByEmail',
  );
}

/** Full-name lookup can legitimately return several rows; the caller decides. */
export async function findByFullName(fullName: string): Promise<ReadymodeAccountRow[]> {
  return unwrap<ReadymodeAccountRow[]>(
    await db().from(TABLE).select('*').ilike('full_name', fullName).order('username'),
    'accounts.findByFullName',
  );
}

export async function listLicenseHolders(licenseType?: string): Promise<ReadymodeAccountRow[]> {
  let query = db().from(TABLE).select('*').eq('license_in_use', true);
  if (licenseType) query = query.eq('license_type', licenseType);
  return unwrap<ReadymodeAccountRow[]>(await query.order('full_name'), 'accounts.listLicenseHolders');
}

export interface AccountSnapshot {
  readymodeUserId?: string | null;
  username?: string | null;
  email?: string | null;
  fullName?: string | null;
  agentRole?: string | null;
  licenseType?: string | null;
  team?: string | null;
  campaign?: string | null;
  queue?: string | null;
  active?: boolean | null;
  licenseInUse?: boolean | null;
  snapshot?: Record<string, unknown>;
}

function toColumns(account: AccountSnapshot): Record<string, unknown> {
  return {
    readymode_user_id: account.readymodeUserId ?? null,
    username: account.username ?? null,
    email: account.email ?? null,
    full_name: account.fullName ?? null,
    agent_role: account.agentRole ?? null,
    license_type: account.licenseType ?? null,
    team: account.team ?? null,
    campaign: account.campaign ?? null,
    queue: account.queue ?? null,
    active: account.active ?? null,
    license_in_use: account.licenseInUse ?? null,
    snapshot: sanitizeForAudit(account.snapshot ?? {}),
    last_seen_at: new Date().toISOString(),
  };
}

/**
 * Record what we just saw.
 *
 * Conflict handling depends on which identity the row carries, because
 * Readymode does not always expose an internal id: prefer the Readymode user
 * id, then username, then email.
 */
export async function record(account: AccountSnapshot): Promise<ReadymodeAccountRow> {
  const columns = toColumns(account);

  const onConflict = account.readymodeUserId
    ? 'readymode_user_id'
    : account.username
      ? 'username'
      : account.email
        ? 'email'
        : undefined;

  if (!onConflict) {
    const inserted = unwrap<ReadymodeAccountRow[]>(
      await db().from(TABLE).insert(columns).select('*'),
      'accounts.record',
    );
    const row = inserted[0];
    if (!row) throw new Error('readymode_accounts insert returned no row');
    return row;
  }

  const rows = unwrap<ReadymodeAccountRow[]>(
    await db().from(TABLE).upsert(columns, { onConflict }).select('*'),
    'accounts.record',
  );
  const row = rows[0];
  if (!row) throw new Error('readymode_accounts upsert returned no row');
  return row;
}

/** Replace the cached directory after a full read of the Readymode agent list. */
export async function recordMany(accounts: AccountSnapshot[]): Promise<void> {
  for (const account of accounts) {
    await record(account);
  }
}
