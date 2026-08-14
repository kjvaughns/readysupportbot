import { db, unwrap, unwrapMaybe } from '../client.js';
import type { ErrorCategory } from '../../domain/errors.js';
import { sanitizeForAudit } from '../../security/redact.js';
import type { BrowserSessionRow, BrowserSessionStatus, ReadymodeAuthState } from '../types.js';

/**
 * Browserbase session bookkeeping.
 *
 * Records that a session existed and what Readymode made of it. No cookies,
 * tokens or credentials are written here — those stay inside the Browserbase
 * persistent context.
 */

const TABLE = 'browser_sessions';

export interface OpenSessionInput {
  browserbaseSessionId: string | null;
  contextId: string;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function open(input: OpenSessionInput): Promise<BrowserSessionRow> {
  const rows = unwrap<BrowserSessionRow[]>(
    await db()
      .from(TABLE)
      .insert({
        browserbase_session_id: input.browserbaseSessionId,
        context_id: input.contextId,
        request_id: input.requestId ?? null,
        metadata: sanitizeForAudit(input.metadata ?? {}),
      })
      .select('*'),
    'browserSessions.open',
  );

  const row = rows[0];
  if (!row) throw new Error('browser_sessions insert returned no row');
  return row;
}

export interface SessionPatch {
  browserbaseSessionId?: string | null;
  status?: BrowserSessionStatus;
  authState?: ReadymodeAuthState;
  performedLogin?: boolean;
  verificationDetected?: boolean;
  lastCheckedAt?: string | null;
  endedAt?: string | null;
  errorCategory?: ErrorCategory | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
}

export async function update(id: string, patch: SessionPatch): Promise<void> {
  const columns: Record<string, unknown> = {};
  if (patch.browserbaseSessionId !== undefined) {
    columns['browserbase_session_id'] = patch.browserbaseSessionId;
  }
  if (patch.status !== undefined) columns['status'] = patch.status;
  if (patch.authState !== undefined) columns['auth_state'] = patch.authState;
  if (patch.performedLogin !== undefined) columns['performed_login'] = patch.performedLogin;
  if (patch.verificationDetected !== undefined) {
    columns['verification_detected'] = patch.verificationDetected;
  }
  if (patch.lastCheckedAt !== undefined) columns['last_checked_at'] = patch.lastCheckedAt;
  if (patch.endedAt !== undefined) columns['ended_at'] = patch.endedAt;
  if (patch.errorCategory !== undefined) columns['error_category'] = patch.errorCategory;
  if (patch.errorMessage !== undefined) columns['error_message'] = patch.errorMessage;
  if (patch.metadata !== undefined) columns['metadata'] = sanitizeForAudit(patch.metadata);

  if (Object.keys(columns).length === 0) return;

  unwrap<BrowserSessionRow[]>(
    await db().from(TABLE).update(columns).eq('id', id).select('id'),
    'browserSessions.update',
  );
}

export async function close(
  id: string,
  status: BrowserSessionStatus = 'CLOSED',
  error?: { category: ErrorCategory; message: string },
): Promise<void> {
  await update(id, {
    status,
    endedAt: new Date().toISOString(),
    ...(error ? { errorCategory: error.category, errorMessage: error.message } : {}),
  });
}

export async function findMostRecent(): Promise<BrowserSessionRow | null> {
  return unwrapMaybe<BrowserSessionRow>(
    await db().from(TABLE).select('*').order('started_at', { ascending: false }).limit(1).maybeSingle(),
    'browserSessions.findMostRecent',
  );
}

/**
 * Mark sessions left ACTIVE by a crashed process as failed, so the health view
 * does not show a session that is not really there.
 */
export async function closeOrphaned(): Promise<number> {
  const rows = unwrap<BrowserSessionRow[]>(
    await db()
      .from(TABLE)
      .update({
        status: 'FAILED',
        ended_at: new Date().toISOString(),
        error_message: 'ReadySupport restarted while this browser session was open.',
      })
      .eq('status', 'ACTIVE')
      .select('id'),
    'browserSessions.closeOrphaned',
  );
  return rows.length;
}
