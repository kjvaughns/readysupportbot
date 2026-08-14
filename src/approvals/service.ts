import { env } from '../config/env.js';
import { errorFor } from '../domain/errors.js';
import type { StructuredAction } from '../domain/actions.js';
import * as approvals from '../db/repositories/approvals.js';
import * as requests from '../db/repositories/requests.js';
import type { AutomationApprovalRow, AutomationRequestRow } from '../db/types.js';
import * as audit from '../audit/audit.js';
import { approvalRequirementFor, canApprove, canCancel, type ApprovalRequirement } from '../auth/permissions.js';
import type { Principal } from '../auth/authorize.js';
import { newNonce } from '../util/ids.js';
import { isExpired, minutes } from '../util/time.js';
import { safeEquals } from '../security/crypto.js';
import { moduleLogger } from '../util/logger.js';

/**
 * Approval management.
 *
 * A mutating request is not queued until a named human has confirmed the exact
 * values that will be submitted. The confirmation is bound to a nonce stored
 * alongside the request, so a button from an older message, a replayed
 * interaction, or a hand-crafted custom_id cannot approve anything.
 *
 * Three defences guard the independence rule for deactivations and bulk work:
 * this service, the permission check it calls, and a database trigger. The
 * expiry is likewise enforced both here at click time and by a periodic sweep,
 * so a request cannot slip through because a sweep was late.
 */

const log = moduleLogger('approvals');

export interface ApprovalHandle {
  approval: AutomationApprovalRow;
  requirement: ApprovalRequirement;
  /** Value to embed in the Confirm/Cancel button custom ids. */
  nonce: string;
  expiresAt: string;
}

/** Open an approval for a request that is waiting on one. */
export async function requestApproval(
  request: AutomationRequestRow,
  action: StructuredAction,
): Promise<ApprovalHandle> {
  const requirement = approvalRequirementFor(action);
  if (!requirement.required) {
    throw new Error(`${action.action} does not require approval`);
  }

  const ttlMs = minutes(env().APPROVAL_TTL_MINUTES);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const nonce = newNonce();

  const approval = await approvals.create({
    requestId: request.id,
    nonce,
    requiredRole: requirement.minimumRole,
    requiresIndependent: requirement.independent,
    expiresAt,
  });

  await requests.update(request.id, { approvalExpiresAt: expiresAt });
  await audit.recordForRequest(request, 'APPROVAL_REQUESTED', {
    metadata: {
      requiresIndependentApprover: requirement.independent,
      minimumRole: requirement.minimumRole,
      expiresAt,
    },
  });

  return { approval, requirement, nonce, expiresAt };
}

export type DecisionOutcome =
  | { ok: true; request: AutomationRequestRow; approval: AutomationApprovalRow }
  | { ok: false; reason: string; category: 'EXPIRED' | 'ALREADY_DECIDED' | 'NOT_ALLOWED' | 'NOT_FOUND' };

interface DecisionInput {
  requestId: string;
  nonce: string;
  actor: Principal;
  note?: string;
}

/**
 * Load and validate the request and its open approval.
 *
 * Every failure mode returns rather than throws, because each one has a
 * different sentence for the person who clicked and none of them is an
 * exception in the ordinary sense — an expired approval is a normal outcome.
 */
async function loadOpenApproval(
  input: DecisionInput,
): Promise<
  | { ok: true; request: AutomationRequestRow; approval: AutomationApprovalRow }
  | { ok: false; reason: string; category: 'EXPIRED' | 'ALREADY_DECIDED' | 'NOT_FOUND' }
> {
  const request = await requests.findById(input.requestId);
  if (!request) {
    return { ok: false, category: 'NOT_FOUND', reason: 'I could not find that request any more.' };
  }

  const approval = await approvals.findPendingForRequest(request.id);
  if (!approval) {
    return {
      ok: false,
      category: 'ALREADY_DECIDED',
      reason: 'That request has already been decided.',
    };
  }

  // Constant-time comparison: the nonce is the thing standing between a
  // guessed custom_id and an approved job.
  if (!safeEquals(approval.nonce, input.nonce)) {
    log.warn(
      { requestId: request.id, actor: input.actor.discordUserId },
      'Approval click carried a nonce that did not match the open approval',
    );
    return {
      ok: false,
      category: 'ALREADY_DECIDED',
      reason: 'That confirmation is no longer valid. Please submit the request again.',
    };
  }

  if (isExpired(approval.expires_at) || request.status !== 'AWAITING_APPROVAL') {
    return {
      ok: false,
      category: 'EXPIRED',
      reason: 'That confirmation expired. Please submit the request again.',
    };
  }

  return { ok: true, request, approval };
}

/**
 * Confirm a request and move it into the queue.
 *
 * Ordering matters: the approval row is decided first, conditionally on it
 * still being PENDING. If two people click at the same moment, exactly one
 * update succeeds and only that one goes on to queue the job.
 */
export async function confirm(input: DecisionInput): Promise<DecisionOutcome> {
  const loaded = await loadOpenApproval(input);
  if (!loaded.ok) return loaded;

  const { request, approval } = loaded;

  const permitted = canApprove({
    approver: input.actor,
    requesterDiscordId: request.requester_discord_id,
    requirement: {
      independent: approval.requires_independent,
      minimumRole: approval.required_role,
    },
  });

  if (!permitted.allowed) {
    await audit.recordForRequest(request, 'PERMISSION_DENIED', {
      discordUserId: input.actor.discordUserId,
      userRole: input.actor.role,
      errorCategory: 'PERMISSION_DENIED',
      errorMessage: permitted.message ?? 'Not allowed to approve',
      metadata: { attempted: 'APPROVE' },
    });
    return {
      ok: false,
      category: 'NOT_ALLOWED',
      reason: permitted.message ?? 'You cannot confirm this one.',
    };
  }

  const decided = await approvals.decide({
    approvalId: approval.id,
    decision: 'CONFIRMED',
    decidedByDiscordId: input.actor.discordUserId,
    decidedByRole: input.actor.role,
    ...(input.note ? { note: input.note } : {}),
  });

  if (!decided) {
    return {
      ok: false,
      category: 'ALREADY_DECIDED',
      reason: 'Someone confirmed or cancelled that a moment before you did.',
    };
  }

  const approvedAt = new Date().toISOString();
  const queued = await requests.update(
    request.id,
    {
      status: 'APPROVED',
      approverDiscordId: input.actor.discordUserId,
      approverBotUserId: input.actor.botUserId,
      approverRole: input.actor.role,
      approvedAt,
    },
    'AWAITING_APPROVAL',
  );

  await audit.recordForRequest(queued, 'APPROVAL_GRANTED', {
    discordUserId: input.actor.discordUserId,
    userRole: input.actor.role,
    approvedAt,
    metadata: { independent: approval.requires_independent },
  });
  await audit.recordForRequest(queued, 'QUEUED', { approvedAt });

  return { ok: true, request: queued, approval: decided };
}

/** Cancel a pending request. */
export async function cancel(input: DecisionInput): Promise<DecisionOutcome> {
  const loaded = await loadOpenApproval(input);
  if (!loaded.ok) return loaded;

  const { request, approval } = loaded;

  const permitted = canCancel({ actor: input.actor, requesterDiscordId: request.requester_discord_id });
  if (!permitted.allowed) {
    return {
      ok: false,
      category: 'NOT_ALLOWED',
      reason: permitted.message ?? 'You cannot cancel this one.',
    };
  }

  const decided = await approvals.decide({
    approvalId: approval.id,
    decision: 'CANCELLED',
    decidedByDiscordId: input.actor.discordUserId,
    decidedByRole: input.actor.role,
    ...(input.note ? { note: input.note } : {}),
  });

  if (!decided) {
    return {
      ok: false,
      category: 'ALREADY_DECIDED',
      reason: 'Someone confirmed or cancelled that a moment before you did.',
    };
  }

  const cancelled = await requests.update(
    request.id,
    {
      status: 'CANCELLED',
      completedAt: new Date().toISOString(),
      errorMessage: 'Cancelled before it ran.',
    },
    'AWAITING_APPROVAL',
  );

  await audit.recordForRequest(cancelled, 'CANCELLED', {
    discordUserId: input.actor.discordUserId,
    userRole: input.actor.role,
  });

  return { ok: true, request: cancelled, approval: decided };
}

/**
 * Expire everything past its window. Run periodically; also called before the
 * queue claims work so a late sweep cannot let a stale approval through.
 */
export async function sweepExpired(): Promise<number> {
  try {
    const expired = await requests.expireStaleApprovals();
    if (expired > 0) log.info({ expired }, 'Expired stale approvals');
    return expired;
  } catch (cause) {
    log.error({ err: cause }, 'Could not sweep expired approvals');
    return 0;
  }
}

/** Guard used by the queue: refuses to run anything that was never approved. */
export async function assertWasApproved(request: AutomationRequestRow): Promise<void> {
  const rows = await approvals.listForRequest(request.id);
  const confirmed = rows.find((row) => row.decision === 'CONFIRMED');

  if (!confirmed) {
    throw errorFor('PERMISSION_DENIED', {
      message: 'This request was never confirmed, so I did not run it.',
      details: { requestId: request.id },
    });
  }
}
