import { db, unwrap } from '../client.js';
import type { ActionType } from '../../domain/actions.js';
import type { ErrorCategory } from '../../domain/errors.js';
import type { BotRole } from '../../domain/roles.js';
import type { RequestStatus } from '../../domain/status.js';
import { sanitizeForAudit } from '../../security/redact.js';
import type { AuditEventType, AutomationEventRow } from '../types.js';

const TABLE = 'automation_events';

export interface AppendEventInput {
  requestId?: string | null;
  reference?: number | null;
  eventType: AuditEventType;
  discordUserId?: string | null;
  userRole?: BotRole | null;
  action?: ActionType | null;
  target?: string | null;
  requestedAt?: string | null;
  approvedAt?: string | null;
  executedAt?: string | null;
  status?: RequestStatus | null;
  previousState?: unknown;
  newState?: unknown;
  errorCategory?: ErrorCategory | null;
  errorMessage?: string | null;
  screenshotPath?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Write one audit row. Every state payload is sanitized here rather than at the
 * call sites, so a caller cannot forget.
 *
 * The table rejects updates and deletes, so this is the only way a fact enters
 * the audit trail and it can never be revised afterwards.
 */
export async function append(input: AppendEventInput): Promise<AutomationEventRow> {
  const rows = unwrap<AutomationEventRow[]>(
    await db()
      .from(TABLE)
      .insert({
        request_id: input.requestId ?? null,
        reference: input.reference ?? null,
        event_type: input.eventType,
        discord_user_id: input.discordUserId ?? null,
        user_role: input.userRole ?? null,
        action: input.action ?? null,
        target: input.target ?? null,
        requested_at: input.requestedAt ?? null,
        approved_at: input.approvedAt ?? null,
        executed_at: input.executedAt ?? null,
        status: input.status ?? null,
        previous_state: input.previousState === undefined ? null : sanitizeForAudit(input.previousState),
        new_state: input.newState === undefined ? null : sanitizeForAudit(input.newState),
        error_category: input.errorCategory ?? null,
        error_message: input.errorMessage ?? null,
        screenshot_path: input.screenshotPath ?? null,
        metadata: sanitizeForAudit(input.metadata ?? {}),
      })
      .select('*'),
    'events.append',
  );

  const row = rows[0];
  if (!row) throw new Error('automation_events insert returned no row');
  return row;
}

export async function listForRequest(requestId: string): Promise<AutomationEventRow[]> {
  return unwrap<AutomationEventRow[]>(
    await db().from(TABLE).select('*').eq('request_id', requestId).order('occurred_at'),
    'events.listForRequest',
  );
}

export async function listRecent(limit = 25): Promise<AutomationEventRow[]> {
  return unwrap<AutomationEventRow[]>(
    await db().from(TABLE).select('*').order('occurred_at', { ascending: false }).limit(limit),
    'events.listRecent',
  );
}

/** Count events of a type since a timestamp — used by the health checks. */
export async function countSince(eventType: AuditEventType, sinceIso: string): Promise<number> {
  const { count, error } = await db()
    .from(TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('event_type', eventType)
    .gte('occurred_at', sinceIso);

  if (error) throw new Error(`Could not count ${eventType} events: ${error.message}`);
  return count ?? 0;
}
