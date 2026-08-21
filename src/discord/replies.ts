import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { Action } from '../openai/schema';
import { ChangePreview, describeAction } from '../readymode/executor';
import { WorkflowResult } from '../types';
import { escapeDiscord } from '../security/sanitize';
import { formatStates } from '../readymode/states';

/** Button ids carry the request they belong to. */
export const BUTTON_PREFIX = 'rs';

export function confirmationButtons(requestId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BUTTON_PREFIX}:confirm:${requestId}`)
      .setLabel('Confirm')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${BUTTON_PREFIX}:edit:${requestId}`)
      .setLabel('Edit')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${BUTTON_PREFIX}:cancel:${requestId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger),
  );
}

export function parseButtonId(
  customId: string,
): { action: 'confirm' | 'edit' | 'cancel'; requestId: string } | null {
  const parts = customId.split(':');
  if (parts.length !== 3 || parts[0] !== BUTTON_PREFIX) return null;
  if (!['confirm', 'edit', 'cancel'].includes(parts[1])) return null;
  return { action: parts[1] as 'confirm' | 'edit' | 'cancel', requestId: parts[2] };
}

/** The confirmation shown before any change is made. */
export function confirmationMessage(input: {
  action: Action;
  preview: ChangePreview;
  needsSecondApprover: boolean;
  dryRun: boolean;
}): string {
  const heading = isStateAction(input.action)
    ? 'ReadySupport is ready to update your states.'
    : `ReadySupport is ready to ${describeAction(input.action).toLowerCase()}.`;

  const lines = [heading, ...input.preview.lines.map((line) => escapeDiscord(line))];

  if (input.needsSecondApprover) {
    lines.push('This change also needs a second Owner or Administrator to confirm.');
  }
  if (input.dryRun) {
    lines.push('Dry run is on, so nothing will be saved in Readymode.');
  }
  lines.push('Confirm  ·  Edit  ·  Cancel');

  return lines.join('\n');
}

function isStateAction(action: Action): boolean {
  return ['SET_STATES', 'ADD_STATES', 'REMOVE_STATES', 'COPY_STATE_CONFIGURATION'].includes(
    action.action,
  );
}

/** The reply sent after a change has run and been verified. */
export function successMessage(input: {
  action: Action;
  result: WorkflowResult;
  reference: string;
}): string {
  const details = (input.result.details ?? {}) as Record<string, unknown>;

  if (isStateAction(input.action)) {
    const assigned = Array.isArray(details.assignedStates) ? (details.assignedStates as string[]) : [];
    const lines = [
      input.result.dryRun
        ? 'Dry run complete. Nothing was saved in Readymode.'
        : 'Your state configuration was updated.',
    ];
    if (details.agent) lines.push(`Agent: ${escapeDiscord(String(details.agent))}`);
    lines.push(`Assigned states: ${formatStates(assigned)}`);
    if (Array.isArray(details.added) && (details.added as string[]).length > 0) {
      lines.push(`Added: ${formatStates(details.added as string[])}`);
    }
    if (Array.isArray(details.removed) && (details.removed as string[]).length > 0) {
      lines.push(`Removed: ${formatStates(details.removed as string[])}`);
    }
    lines.push(input.result.verified ? 'Verified in Readymode' : 'Not verified — dry run');
    lines.push(`Request ID: ${input.reference}`);
    return lines.join('\n');
  }

  const lines = [escapeDiscord(input.result.summary)];
  lines.push(input.result.verified ? 'Verified in Readymode' : 'Not verified — dry run');
  lines.push(`Request ID: ${input.reference}`);
  return lines.join('\n');
}

export function failureMessage(reference: string, message: string): string {
  return [escapeDiscord(message), `Request ID: ${reference}`].join('\n');
}

export const HELP_TEXT = [
  'ReadySupport performs approved administrative work in Readymode.',
  '',
  'Ask in plain language, for example:',
  '- "@ReadySupport can you set it up where I am only receiving TX, VA and OH states?"',
  '- "@ReadySupport add Florida to Sarah Chen\'s states."',
  '- "@ReadySupport is Marcus Webb logged in?"',
  '- "@ReadySupport log out the inactive users, we are out of seats."',
  '- "@ReadySupport put Sarah Chen in the Gold playlist."',
  '- "@ReadySupport my audio isn\'t working on calls."',
  '',
  'Slash commands:',
  'Accounts: /create_account · /create_accounts · /reset_password · /deactivate_account',
  'Seats: /clear-licenses (log out inactive users) · /clear_license · /force-logout · /license_usage',
  'Assignments: /add-assignment · /remove-assignment · /view-assignments',
  'States: /set_states · /add_states · /remove_states · /view_states',
  'Help: /troubleshoot · /agent_status · /connection_status · /recent_actions · /help',
  '',
  'Every change is shown for confirmation before it runs. Deactivations and bulk changes also need a second Owner or Administrator.',
].join('\n');
