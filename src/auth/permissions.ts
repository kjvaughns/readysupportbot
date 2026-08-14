import {
  isMutating,
  SECOND_APPROVER_ACTIONS,
  type ActionType,
  type StructuredAction,
} from '../domain/actions.js';
import { canApproveForOthers, type BotRole } from '../domain/roles.js';
import type { Principal } from './authorize.js';

/**
 * Approval policy: what needs signing off, by whom, and by whom it must NOT be
 * signed off.
 */

export interface ApprovalRequirement {
  /** Does anything have to be confirmed before this runs? */
  required: boolean;
  /** Must the approver be someone other than the requester? */
  independent: boolean;
  /** Minimum role that may decide. */
  minimumRole: BotRole;
  /** One line explaining the rule, shown on the confirmation embed. */
  reason: string;
}

const NOT_REQUIRED: ApprovalRequirement = {
  required: false,
  independent: false,
  minimumRole: 'VIEWER',
  reason: 'Read-only, nothing to confirm.',
};

/**
 * Bulk work — an action affecting many accounts at once — carries the same
 * independent-approver rule as a deactivation. Today no action accepts a list
 * of targets, so this returns false; it is the single place to change when one
 * does, rather than a condition scattered through the workflows.
 */
export function isBulk(_action: StructuredAction): boolean {
  return false;
}

export function approvalRequirementFor(action: StructuredAction): ApprovalRequirement {
  if (!isMutating(action.action)) return NOT_REQUIRED;

  if (SECOND_APPROVER_ACTIONS.has(action.action) || isBulk(action)) {
    return {
      required: true,
      independent: true,
      minimumRole: 'ADMIN',
      reason:
        'Deactivations and bulk changes need sign-off from a different owner or admin than the person who asked.',
    };
  }

  return {
    required: true,
    independent: false,
    minimumRole: 'SUPPORT',
    reason: 'This changes Readymode, so it needs a confirmation first.',
  };
}

export interface ApprovalCheck {
  allowed: boolean;
  /** Sentence shown to whoever clicked, when not allowed. */
  message?: string;
}

/**
 * Decide whether a specific person may approve a specific request.
 *
 * The independence rule is enforced here, again in the approvals service
 * against the stored row, and once more by a database trigger. It is the rule
 * most worth defending in depth: it is the only thing standing between one
 * compromised or careless account and a unilateral deactivation.
 */
export function canApprove(input: {
  approver: Principal;
  requesterDiscordId: string;
  requirement: Pick<ApprovalRequirement, 'independent' | 'minimumRole'>;
}): ApprovalCheck {
  const { approver, requesterDiscordId, requirement } = input;

  if (requirement.independent) {
    if (approver.discordUserId === requesterDiscordId) {
      return {
        allowed: false,
        message:
          'This one needs a second pair of eyes. Someone other than the person who asked has to confirm it.',
      };
    }
    if (!canApproveForOthers(approver.role)) {
      return {
        allowed: false,
        message: 'Only an owner or an admin can confirm this one.',
      };
    }
    return { allowed: true };
  }

  // Ordinary confirmation: the requester confirms their own request. Anyone
  // else confirming must at least be able to perform the action themselves.
  if (approver.discordUserId === requesterDiscordId) return { allowed: true };

  if (!canApproveForOthers(approver.role)) {
    return {
      allowed: false,
      message: 'Only the person who asked, or an owner or admin, can confirm this.',
    };
  }

  return { allowed: true };
}

/** Who may cancel a pending request: the requester, or any owner or admin. */
export function canCancel(input: {
  actor: Principal;
  requesterDiscordId: string;
}): ApprovalCheck {
  if (input.actor.discordUserId === input.requesterDiscordId) return { allowed: true };
  if (canApproveForOthers(input.actor.role)) return { allowed: true };
  return { allowed: false, message: 'Only the person who asked, or an owner or admin, can cancel this.' };
}

/**
 * Actions whose result must be delivered privately because it carries a
 * credential.
 */
export function deliversCredentials(action: ActionType): boolean {
  return action === 'CREATE_ACCOUNT' || action === 'RESET_PASSWORD';
}
