import { Action } from '../openai/schema';
import { describeAction, ChangePreview } from '../readymode/executor';
import { ControlSource, capabilityForAction } from '../readymode/selectors/capabilities';
import { inspectedControlFor } from '../readymode/interface/registry';
import { escapeDiscord } from '../security/sanitize';
import { Classification, KIND_LABELS } from './classification';

/**
 * What ReadySupport is about to do, written out before it does it.
 *
 * Six things, because those are the six a person needs in order to say yes: what
 * was understood, what would change, whose account it touches, which controls
 * would be used, what approval is required, and what would count as success.
 *
 * The fourth is the unusual one, and it is the point. Naming the selectors — and
 * where each came from — means an administrator confirming a change can see
 * whether ReadySupport is acting on something an Owner approved or on a guess,
 * without taking anybody's word for it.
 */

export interface PlanSelector {
  control: string;
  source: ControlSource;
  /** The evidence status of the inspected control, when there is one. */
  evidence?: string;
}

export interface PlanCard {
  classification: Classification;
  understood: string;
  /** The concrete before-and-after, from the change preview. */
  change: string[];
  affected: string;
  selectors: PlanSelector[];
  approval: string;
  success: string[];
  dryRun: boolean;
}

export function buildPlan(input: {
  action: Action;
  classification: Classification;
  preview?: ChangePreview | null;
  affected?: string | null;
  needsSecondApprover?: boolean;
  dryRun: boolean;
  /** Where each control's selector resolved from, when the report has run. */
  sources?: Record<string, ControlSource>;
}): PlanCard {
  const capability = capabilityForAction(input.action.action);

  const selectors: PlanSelector[] = (capability?.requiredControls ?? []).map((control) => {
    const inspected = inspectedControlFor(control);
    return {
      control,
      source: input.sources?.[control] ?? 'none',
      evidence: inspected?.evidenceStatus,
    };
  });

  const approval = input.needsSecondApprover
    ? 'A second Owner or Administrator has to confirm as well.'
    : input.classification.kind === 'proposed_administrative_action'
      ? 'Waiting for you to confirm.'
      : input.classification.kind === 'approved_administrative_action'
        ? 'Already approved.'
        : 'None — nothing is changed.';

  return {
    classification: input.classification,
    understood: describeAction(input.action),
    change: input.preview?.lines ?? [],
    affected: input.affected ?? input.preview?.agentLabel ?? 'This Readymode account',
    selectors,
    approval,
    dryRun: input.dryRun,
    success: successCriteria(input.action, input.preview ?? null),
  };
}

/**
 * What would have to be true afterwards for this to count as done.
 *
 * Taken from the change itself rather than from a fixed sentence, so the check
 * that runs after the change is the same claim the plan made before it.
 */
function successCriteria(action: Action, preview: ChangePreview | null): string[] {
  const criteria: string[] = [];

  if (preview?.newStates && preview.newStates.length > 0) {
    criteria.push(`Readymode reads back these states: ${preview.newStates.join(', ')}`);
  }

  switch (action.action) {
    case 'CLEAR_ALL_LICENSES':
      criteria.push('Fewer licences are in use, or Readymode reported that none were idle.');
      break;
    case 'FORCE_LOGOUT':
      criteria.push('That user reads as signed out and a licence has been released.');
      break;
    case 'CREATE_ACCOUNT':
    case 'CREATE_ACCOUNTS':
      criteria.push('The new account appears in the user list.');
      break;
    case 'DEACTIVATE_ACCOUNT':
      criteria.push('The account reads as inactive.');
      break;
    default:
      break;
  }

  if (criteria.length === 0) {
    criteria.push('Readymode confirms the change, and re-reading the screen agrees.');
  }

  return criteria;
}

/** How a selector's origin reads to somebody deciding whether to approve. */
const SOURCE_LABELS: Record<ControlSource, string> = {
  approved_profile: 'approved by an Owner for this account',
  observed_file: 'observed in a discovery run and committed',
  interface_map: 'from the recorded interface inspection',
  builtin: 'a built-in guess — not used for changes',
  none: 'not resolved',
};

export function renderPlan(card: PlanCard): string {
  const lines: string[] = [];

  lines.push(`**${KIND_LABELS[card.classification.kind]}**`);
  lines.push(escapeDiscord(card.classification.reason));
  lines.push('');

  lines.push(`**Understood:** ${escapeDiscord(card.understood)}`);
  lines.push(`**Affected:** ${escapeDiscord(card.affected)}`);

  if (card.change.length > 0) {
    lines.push('**Change:**');
    for (const line of card.change.slice(0, 8)) lines.push(`· ${escapeDiscord(line)}`);
  }

  if (card.selectors.length > 0) {
    lines.push('**Controls it would use:**');
    for (const selector of card.selectors) {
      const evidence = selector.evidence ? `, ${selector.evidence}` : '';
      lines.push(`· \`${selector.control}\` — ${SOURCE_LABELS[selector.source]}${evidence}`);
    }
  }

  lines.push(`**Approval:** ${escapeDiscord(card.approval)}`);

  lines.push('**Success means:**');
  for (const criterion of card.success) lines.push(`· ${escapeDiscord(criterion)}`);

  if (card.dryRun) {
    lines.push('');
    lines.push('_Dry run is on, so nothing will be saved in Readymode._');
  }

  return lines.join('\n');
}
