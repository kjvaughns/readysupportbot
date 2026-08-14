import * as events from '../db/repositories/events.js';
import type { AppendEventInput } from '../db/repositories/events.js';
import type { AutomationRequestRow, AuditEventType } from '../db/types.js';
import { moduleLogger } from '../util/logger.js';

/**
 * The audit facade.
 *
 * Everything that matters is recorded here rather than at scattered call
 * sites, so each event carries the same complete set of fields: who asked,
 * with what authority, against what, when it was requested, approved and
 * executed, where it ended up, what changed, and what evidence exists.
 *
 * Audit writes never fail a job. If the database is unreachable we lose the
 * row, and that is worth knowing about loudly, but it is not a reason to
 * abandon a browser action that may already be half done.
 */

const log = moduleLogger('audit');

/** Pull the common fields off a request row so callers do not repeat them. */
function fromRequest(request: AutomationRequestRow): Partial<AppendEventInput> {
  return {
    requestId: request.id,
    reference: request.reference,
    discordUserId: request.requester_discord_id,
    userRole: request.requester_role,
    action: request.action,
    target: request.target_summary,
    requestedAt: request.requested_at,
    approvedAt: request.approved_at,
    executedAt: request.started_at,
    status: request.status,
  };
}

export async function record(input: AppendEventInput): Promise<void> {
  try {
    await events.append(input);
  } catch (cause) {
    log.error(
      { err: cause, eventType: input.eventType, requestId: input.requestId },
      'Could not write an audit event',
    );
  }
}

/** Record an event about a request, merging in its standard fields. */
export async function recordForRequest(
  request: AutomationRequestRow,
  eventType: AuditEventType,
  extra: Partial<AppendEventInput> = {},
): Promise<void> {
  await record({ ...fromRequest(request), ...extra, eventType });
}

/**
 * A denial or an alert that is not tied to a request — an unknown user trying
 * a command, or the browser service going away.
 */
export async function recordSystemEvent(
  eventType: AuditEventType,
  extra: Partial<AppendEventInput> = {},
): Promise<void> {
  await record({ ...extra, eventType });
}

export { type AppendEventInput };
