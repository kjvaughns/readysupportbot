import { config } from '../config';
import { getStore } from '../database';
import { recordEvent } from '../audit';
import { AutomationApproval, AutomationRequest, Role } from '../types';
import { Action } from '../openai/schema';
import { atLeast, isModifyingAction, requireActionPermission } from '../permissions';
import { AppError, ValidationError } from '../security/errors';

/**
 * Approval rules.
 *
 * Every modifying action needs an explicit confirmation. Deactivations and bulk
 * changes need a second, different Owner or Administrator. Approvals go stale
 * after ten minutes so a confirmation can never be replayed against a stale
 * view of the change.
 */

export const APPROVAL_TTL_MS = config.approvalTtlMs;

export interface ApprovalRequirement {
  /** How many distinct approvals the request needs before it can run. */
  required: 1 | 2;
  /** Set when the second approval has to come from an Owner or Administrator. */
  secondApproverMinimumRole?: Extract<Role, 'administrator'>;
  reason: string;
}

/** Actions that always need a second Owner or Administrator. */
export function requiresSecondApprover(action: Action): boolean {
  switch (action.action) {
    case 'DEACTIVATE_ACCOUNT':
      return true;
    case 'CREATE_ACCOUNTS':
      return action.accounts.length > 1;
    case 'SET_DEFAULT_STATES':
      // Changes the baseline for every future agent, so it is a bulk change.
      return true;
    default:
      return false;
  }
}

export function approvalRequirement(action: Action): ApprovalRequirement {
  if (!isModifyingAction(action.action)) {
    return { required: 1, reason: 'Read-only request.' };
  }
  if (requiresSecondApprover(action)) {
    return {
      required: 2,
      secondApproverMinimumRole: 'administrator',
      reason:
        action.action === 'DEACTIVATE_ACCOUNT'
          ? 'Deactivation requires a second Owner or Administrator.'
          : 'Bulk changes require a second Owner or Administrator.',
    };
  }
  return { required: 1, reason: 'Modifying request requires confirmation.' };
}

export function approvalDeadline(awaitingSinceIso: string): number {
  return new Date(awaitingSinceIso).getTime() + APPROVAL_TTL_MS;
}

export function isApprovalExpired(awaitingSinceIso: string, now = Date.now()): boolean {
  return now > approvalDeadline(awaitingSinceIso);
}

export function remainingApprovalMs(awaitingSinceIso: string, now = Date.now()): number {
  return Math.max(0, approvalDeadline(awaitingSinceIso) - now);
}

export interface ApproverIdentity {
  discordUserId?: string | null;
  supabaseUserId?: string | null;
  role: Role;
}

export interface ApprovalDecisionInput {
  request: AutomationRequest;
  action: Action;
  approver: ApproverIdentity;
  existingApprovals: AutomationApproval[];
  awaitingSince: string;
  now?: number;
}

export type ApprovalDecision =
  | { status: 'approved'; approvals: number }
  | { status: 'awaiting_second'; approvals: number; needed: number }
  | { status: 'rejected'; reason: string };

function sameApprover(approval: AutomationApproval, approver: ApproverIdentity): boolean {
  if (approver.discordUserId && approval.approverDiscordUserId) {
    return approval.approverDiscordUserId === approver.discordUserId;
  }
  if (approver.supabaseUserId && approval.approverSupabaseUserId) {
    return approval.approverSupabaseUserId === approver.supabaseUserId;
  }
  return false;
}

/**
 * Pure decision function: given a request, who is approving, and what approvals
 * already exist, decide whether the request may run.
 */
export function evaluateApproval(input: ApprovalDecisionInput): ApprovalDecision {
  const now = input.now ?? Date.now();

  if (isApprovalExpired(input.awaitingSince, now)) {
    return { status: 'rejected', reason: 'This confirmation expired. Send the request again.' };
  }

  if (input.request.status === 'CANCELLED') {
    return { status: 'rejected', reason: 'This request was cancelled.' };
  }

  if (!['AWAITING_APPROVAL', 'PENDING'].includes(input.request.status)) {
    return { status: 'rejected', reason: 'This request is no longer waiting for confirmation.' };
  }

  try {
    requireActionPermission(input.approver.role, input.action.action);
  } catch {
    return { status: 'rejected', reason: 'You do not have permission to approve this request.' };
  }

  if (input.existingApprovals.some((approval) => sameApprover(approval, input.approver))) {
    return { status: 'rejected', reason: 'You have already approved this request.' };
  }

  const requirement = approvalRequirement(input.action);
  const approvals = input.existingApprovals.length + 1;

  if (requirement.required === 2 && approvals >= 2) {
    // The approval that completes the pair must be an Owner or Administrator.
    if (!atLeast(input.approver.role, 'administrator')) {
      return {
        status: 'rejected',
        reason: 'A second approval from an Owner or Administrator is required.',
      };
    }
  }

  if (approvals >= requirement.required) {
    return { status: 'approved', approvals };
  }

  return { status: 'awaiting_second', approvals, needed: requirement.required };
}

/** Persists an approval and returns the resulting decision. */
export async function submitApproval(input: {
  request: AutomationRequest;
  action: Action;
  approver: ApproverIdentity;
  awaitingSince: string;
}): Promise<ApprovalDecision> {
  const store = getStore();
  const existingApprovals = await store.listApprovals(input.request.id);

  const decision = evaluateApproval({
    request: input.request,
    action: input.action,
    approver: input.approver,
    existingApprovals,
    awaitingSince: input.awaitingSince,
  });

  if (decision.status === 'rejected') return decision;

  await store.addApproval({
    requestId: input.request.id,
    organizationId: input.request.organizationId,
    approverDiscordUserId: input.approver.discordUserId ?? null,
    approverSupabaseUserId: input.approver.supabaseUserId ?? null,
    approverRole: input.approver.role,
    sequence: existingApprovals.length + 1,
  });

  await recordEvent({
    organizationId: input.request.organizationId,
    requestId: input.request.id,
    type: decision.status === 'approved' ? 'request.approved' : 'request.awaiting_approval',
    message:
      decision.status === 'approved'
        ? `${input.request.reference} approved.`
        : `${input.request.reference} has one approval and needs a second Owner or Administrator.`,
    data: { approverRole: input.approver.role },
  });

  return decision;
}

/** Timestamp recorded when a request starts waiting for confirmation. */
export function awaitingSinceFrom(request: AutomationRequest): string {
  const payload = request.payload as Record<string, unknown>;
  const value = payload?.awaitingSince;
  if (typeof value === 'string') return value;
  return request.updatedAt ?? request.createdAt;
}

export function assertApprovable(action: Action): void {
  if (!isModifyingAction(action.action)) {
    throw new ValidationError('That request does not need approval.');
  }
}

export class ApprovalExpiredError extends AppError {
  constructor() {
    super('approval_expired', 'This confirmation expired. Send the request again.', 409);
    this.name = 'ApprovalExpiredError';
  }
}
