import { Action } from '../openai/schema';
import { isModifyingAction } from '../permissions';
import { CapabilityStatus, capabilityForAction } from '../readymode/selectors/capabilities';

/**
 * What kind of request this is.
 *
 * Every request lands in exactly one of these, and the kind decides what
 * happens next: a question is answered, an inspection runs, a change is
 * proposed and waits, an approved change runs and is verified, and anything
 * ReadySupport cannot do safely is refused with the reason.
 *
 * The distinction that matters most is between the third and the fourth. A
 * proposed change has been understood and priced; it has not been authorized.
 * Nothing crosses that line except a person confirming it.
 */
export type RequestKind =
  | 'support_question'
  | 'read_only_inspection'
  | 'proposed_administrative_action'
  | 'approved_administrative_action'
  | 'blocked_or_unsupported';

export interface Classification {
  kind: RequestKind;
  /** A sentence saying why, safe to show to whoever asked. */
  reason: string;
}

const QUESTION_ACTIONS = new Set(['HELP', 'TROUBLESHOOT', 'ANSWER_READYMODE_QUESTION']);

export function classifyRequest(input: {
  action: Action;
  /** True once the required approvals are in. */
  approved?: boolean;
  /** The capability report for this action, when one has been run. */
  capability?: CapabilityStatus | null;
  /** Set when permission was refused before anything else was considered. */
  permissionDenied?: string;
}): Classification {
  const { action } = input;

  if (input.permissionDenied) {
    return { kind: 'blocked_or_unsupported', reason: input.permissionDenied };
  }

  if (action.action === 'UNSUPPORTED') {
    return { kind: 'blocked_or_unsupported', reason: action.reason };
  }

  if (QUESTION_ACTIONS.has(action.action)) {
    return {
      kind: 'support_question',
      reason: 'Answered from the official Readymode documentation, with the article linked.',
    };
  }

  if (!isModifyingAction(action.action)) {
    return {
      kind: 'read_only_inspection',
      reason: 'Reads Readymode and reports what is there. Nothing is changed.',
    };
  }

  // Modifying from here down.
  const capability = input.capability;
  if (capability && !capability.usable) {
    return {
      kind: 'blocked_or_unsupported',
      reason:
        capability.blockedReason ??
        `ReadySupport cannot verify how to ${capability.label} in this account, so it will not try.`,
    };
  }

  if (input.approved) {
    return {
      kind: 'approved_administrative_action',
      reason: 'Approved. It will run and then be verified before anything is reported as done.',
    };
  }

  return {
    kind: 'proposed_administrative_action',
    reason: 'Proposed. Nothing changes in Readymode until somebody confirms it.',
  };
}

/** How the kind reads in a Discord reply. */
export const KIND_LABELS: Record<RequestKind, string> = {
  support_question: 'Question',
  read_only_inspection: 'Read-only check',
  proposed_administrative_action: 'Proposed change — needs confirmation',
  approved_administrative_action: 'Approved change — running',
  blocked_or_unsupported: 'Not possible',
};

/** Whether this kind may touch Readymode at all. */
export function mayRunNow(kind: RequestKind): boolean {
  return kind === 'read_only_inspection' || kind === 'approved_administrative_action';
}

/** The controls an action would use, so a plan can name them. */
export function controlsForAction(action: Action): string[] {
  return capabilityForAction(action.action)?.requiredControls ?? [];
}
