import { getStore } from '../database';
import { AutomationEvent } from '../types';
import { logger } from '../security/logger';
import { redact } from '../security/redaction';

/**
 * The audit log is the record of what ReadySupport did and why. Every entry is
 * redacted before it is written, so no credential can be recovered from it.
 */
export type AuditEventType =
  | 'request.created'
  | 'request.needs_information'
  | 'request.awaiting_approval'
  | 'request.approved'
  | 'request.cancelled'
  | 'request.started'
  | 'request.completed'
  | 'request.failed'
  | 'request.duplicate'
  | 'request.authentication_required'
  | 'permission.denied'
  | 'channel.rejected'
  | 'guild.rejected'
  | 'agent.ambiguous'
  | 'agent.not_found'
  | 'states.changed'
  | 'states.verified'
  | 'states.defaults_changed'
  | 'credentials.stored'
  | 'credentials.replaced'
  | 'credentials.deleted'
  | 'connection.updated'
  | 'connection.tested'
  | 'browser.session_started'
  | 'browser.session_ended'
  | 'workflow.needs_configuration'
  | 'prompt_injection.blocked'
  | 'readymode.session_takeover'
  | 'readymode.interface_discovered'
  | 'readymode.profile_approved'
  | 'readymode.profile_rejected'
  | 'readymode.evidence_read'
  | 'readymode.controls_unverified';

export interface AuditInput {
  organizationId: string;
  requestId?: string | null;
  type: AuditEventType;
  message: string;
  data?: Record<string, unknown>;
}

export async function recordEvent(input: AuditInput): Promise<AutomationEvent | null> {
  const safeData = input.data ? (redact(input.data) as Record<string, unknown>) : null;
  try {
    const event = await getStore().addEvent({
      organizationId: input.organizationId,
      requestId: input.requestId ?? null,
      type: input.type,
      message: input.message,
      data: safeData,
    });
    logger.info(
      { auditType: input.type, requestId: input.requestId, organizationId: input.organizationId },
      input.message,
    );
    return event;
  } catch (error) {
    // A failed audit write must not take the request down, but it is loud.
    logger.error({ err: error, auditType: input.type }, 'Failed to write audit event');
    return null;
  }
}

export async function recentActivity(
  organizationId: string,
  limit = 10,
): Promise<AutomationEvent[]> {
  return getStore().listEvents(organizationId, Math.min(Math.max(limit, 1), 100));
}

export async function activityForRequest(requestId: string): Promise<AutomationEvent[]> {
  return getStore().listEventsForRequest(requestId);
}

/** Human-readable single line used in Discord and the frontend activity feed. */
export function describeEvent(event: AutomationEvent): string {
  const timestamp = new Date(event.createdAt).toISOString().replace('T', ' ').slice(0, 19);
  return `${timestamp} UTC — ${event.message}`;
}
