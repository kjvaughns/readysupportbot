import { db, unwrap, unwrapMaybe } from '../client.js';
import { assertTransition, type RequestStatus } from '../../domain/status.js';
import type { ActionType, StructuredAction } from '../../domain/actions.js';
import type { ErrorCategory } from '../../domain/errors.js';
import type { BotRole } from '../../domain/roles.js';
import { sanitizeForAudit } from '../../security/redact.js';
import type { AutomationRequestRow, JsonObject, RequestSource } from '../types.js';

const TABLE = 'automation_requests';

export interface CreateRequestInput {
  action: ActionType;
  source: RequestSource;
  guildId: string;
  channelId: string;
  requesterDiscordId: string;
  requesterBotUserId: string | null;
  requesterRole: BotRole;
  status: RequestStatus;
  input: StructuredAction | Record<string, unknown>;
  targetSummary?: string | null;
  targetRef?: Record<string, unknown>;
  missingFields?: string[];
  requestText?: string | null;
  dryRun: boolean;
  approvalExpiresAt?: string | null;
}

/**
 * Create the request row.
 *
 * The payload is sanitized on the way in, so a temporary password an
 * administrator typed into a slash command never lands in the table. The
 * plaintext lives only in memory for the length of the job.
 */
export async function create(input: CreateRequestInput): Promise<AutomationRequestRow> {
  const rows = unwrap<AutomationRequestRow[]>(
    await db()
      .from(TABLE)
      .insert({
        action: input.action,
        source: input.source,
        status: input.status,
        guild_id: input.guildId,
        channel_id: input.channelId,
        requester_discord_id: input.requesterDiscordId,
        requester_bot_user_id: input.requesterBotUserId,
        requester_role: input.requesterRole,
        target_summary: input.targetSummary ?? null,
        target_ref: sanitizeForAudit(input.targetRef ?? {}),
        input: sanitizeForAudit(input.input),
        missing_fields: input.missingFields ?? [],
        request_text: input.requestText ?? null,
        dry_run: input.dryRun,
        approval_expires_at: input.approvalExpiresAt ?? null,
      })
      .select('*'),
    'requests.create',
  );

  const row = rows[0];
  if (!row) throw new Error('automation_requests insert returned no row');
  return row;
}

export async function findById(id: string): Promise<AutomationRequestRow | null> {
  return unwrapMaybe<AutomationRequestRow>(
    await db().from(TABLE).select('*').eq('id', id).maybeSingle(),
    'requests.findById',
  );
}

export async function findByReference(reference: number): Promise<AutomationRequestRow | null> {
  return unwrapMaybe<AutomationRequestRow>(
    await db().from(TABLE).select('*').eq('reference', reference).maybeSingle(),
    'requests.findByReference',
  );
}

export interface UpdateRequestPatch {
  status?: RequestStatus;
  approverDiscordId?: string | null;
  approverBotUserId?: string | null;
  approverRole?: BotRole | null;
  approvedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  approvalExpiresAt?: string | null;
  interactionMessageId?: string | null;
  targetAccountId?: string | null;
  targetSummary?: string | null;
  input?: Record<string, unknown>;
  missingFields?: string[];
  result?: Record<string, unknown> | null;
  errorCategory?: ErrorCategory | null;
  errorMessage?: string | null;
  screenshotPath?: string | null;
  retryCount?: number;
  dryRun?: boolean;
}

function toColumns(patch: UpdateRequestPatch): JsonObject {
  const columns: JsonObject = {};
  if (patch.status !== undefined) columns['status'] = patch.status;
  if (patch.approverDiscordId !== undefined) columns['approver_discord_id'] = patch.approverDiscordId;
  if (patch.approverBotUserId !== undefined) columns['approver_bot_user_id'] = patch.approverBotUserId;
  if (patch.approverRole !== undefined) columns['approver_role'] = patch.approverRole;
  if (patch.approvedAt !== undefined) columns['approved_at'] = patch.approvedAt;
  if (patch.startedAt !== undefined) columns['started_at'] = patch.startedAt;
  if (patch.completedAt !== undefined) columns['completed_at'] = patch.completedAt;
  if (patch.approvalExpiresAt !== undefined) columns['approval_expires_at'] = patch.approvalExpiresAt;
  if (patch.interactionMessageId !== undefined) {
    columns['interaction_message_id'] = patch.interactionMessageId;
  }
  if (patch.targetAccountId !== undefined) columns['target_account_id'] = patch.targetAccountId;
  if (patch.targetSummary !== undefined) columns['target_summary'] = patch.targetSummary;
  if (patch.input !== undefined) columns['input'] = sanitizeForAudit(patch.input);
  if (patch.missingFields !== undefined) columns['missing_fields'] = patch.missingFields;
  if (patch.result !== undefined) {
    columns['result'] = patch.result === null ? null : sanitizeForAudit(patch.result);
  }
  if (patch.errorCategory !== undefined) columns['error_category'] = patch.errorCategory;
  if (patch.errorMessage !== undefined) columns['error_message'] = patch.errorMessage;
  if (patch.screenshotPath !== undefined) columns['screenshot_path'] = patch.screenshotPath;
  if (patch.retryCount !== undefined) columns['retry_count'] = patch.retryCount;
  if (patch.dryRun !== undefined) columns['dry_run'] = patch.dryRun;
  return columns;
}

/**
 * Apply a patch. When the patch moves the request to a new status, the
 * transition is validated against the state machine first, and the update is
 * made conditional on the row still being in the status we checked — so two
 * racing callers cannot both "win".
 */
export async function update(
  id: string,
  patch: UpdateRequestPatch,
  expectedStatus?: RequestStatus,
): Promise<AutomationRequestRow> {
  if (patch.status && expectedStatus) {
    assertTransition(expectedStatus, patch.status, id);
  }

  let query = db().from(TABLE).update(toColumns(patch)).eq('id', id);
  if (expectedStatus) query = query.eq('status', expectedStatus);

  const rows = unwrap<AutomationRequestRow[]>(await query.select('*'), 'requests.update');

  const row = rows[0];
  if (!row) {
    throw new Error(
      expectedStatus
        ? `Request ${id} was no longer in status ${expectedStatus}; another process changed it first.`
        : `Request ${id} not found`,
    );
  }
  return row;
}

/** Move to a new status, validating the transition from the row's current one. */
export async function transition(
  id: string,
  to: RequestStatus,
  patch: Omit<UpdateRequestPatch, 'status'> = {},
): Promise<AutomationRequestRow> {
  const current = await findById(id);
  if (!current) throw new Error(`Request ${id} not found`);
  assertTransition(current.status, to, id);
  return update(id, { ...patch, status: to }, current.status);
}

/**
 * Atomically claim the oldest approved job and mark it RUNNING.
 * Returns null when the queue is empty or paused.
 */
export async function claimNext(): Promise<AutomationRequestRow | null> {
  const { data, error } = await db().rpc('claim_next_request');
  if (error) {
    throw new Error(`Could not claim the next queued request: ${error.message}`);
  }
  return (data as AutomationRequestRow | null) ?? null;
}

/** Called at boot. Fails anything stranded in RUNNING; never retries it. */
export async function quarantineInterrupted(): Promise<number> {
  const { data, error } = await db().rpc('quarantine_interrupted_requests');
  if (error) {
    throw new Error(`Could not recover interrupted requests: ${error.message}`);
  }
  return typeof data === 'number' ? data : 0;
}

export async function expireStaleApprovals(): Promise<number> {
  const { data, error } = await db().rpc('expire_stale_approvals');
  if (error) {
    throw new Error(`Could not expire stale approvals: ${error.message}`);
  }
  return typeof data === 'number' ? data : 0;
}

export interface ListRecentOptions {
  limit: number;
  /** Restrict to one requester — used for VIEWER, who only sees their own. */
  requesterDiscordId?: string;
  statuses?: RequestStatus[];
}

export async function listRecent(options: ListRecentOptions): Promise<AutomationRequestRow[]> {
  let query = db().from(TABLE).select('*').order('requested_at', { ascending: false }).limit(options.limit);

  if (options.requesterDiscordId) {
    query = query.eq('requester_discord_id', options.requesterDiscordId);
  }
  if (options.statuses?.length) {
    query = query.in('status', options.statuses);
  }

  return unwrap<AutomationRequestRow[]>(await query, 'requests.listRecent');
}

/** Requests parked because Readymode needs reconnecting. */
export async function listBlockedOnAuthentication(): Promise<AutomationRequestRow[]> {
  return unwrap<AutomationRequestRow[]>(
    await db().from(TABLE).select('*').eq('status', 'AUTHENTICATION_REQUIRED').order('requested_at'),
    'requests.listBlockedOnAuthentication',
  );
}

export async function countByStatus(status: RequestStatus): Promise<number> {
  const { count, error } = await db()
    .from(TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('status', status);

  if (error) throw new Error(`Could not count ${status} requests: ${error.message}`);
  return count ?? 0;
}

/** Failures in the recent past, for the health check. */
export async function countRecentFailures(sinceIso: string): Promise<number> {
  const { count, error } = await db()
    .from(TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('status', 'FAILED')
    .gte('completed_at', sinceIso);

  if (error) throw new Error(`Could not count recent failures: ${error.message}`);
  return count ?? 0;
}
