import { EmbedBuilder, type APIEmbedField } from 'discord.js';
import {
  ACTION_LABELS,
  describeTarget,
  type StructuredAction,
} from '../domain/actions.js';
import { STATUS_LABELS } from '../domain/status.js';
import type { ApprovalRequirement } from '../auth/permissions.js';
import type { AutomationRequestRow } from '../db/types.js';
import type { LicenseUsage, ReadymodeAccount } from '../readymode/port.js';
import { formatReference } from '../util/ids.js';
import { discordTimestamp } from '../util/time.js';
import { escapeForDiscord, truncate } from '../util/text.js';

/**
 * Discord presentation.
 *
 * Two rules run through all of this. Every value that came from outside the
 * system — an agent name, a campaign, a status banner read off a Readymode
 * page — is escaped before it is rendered, so it cannot forge a mention, a
 * link or a fake line of bot output. And no embed ever carries a password;
 * credentials are delivered separately, ephemerally, by the credential path.
 */

export const COLORS = {
  pending: 0x5865f2,
  success: 0x57f287,
  failure: 0xed4245,
  warning: 0xfee75c,
  neutral: 0x99aab5,
} as const;

function field(name: string, value: string, inline = true): APIEmbedField {
  return { name, value: truncate(value || '—', 1024), inline };
}

/** Render an untrusted string for display. */
function safe(value: string | null | undefined, fallback = '—'): string {
  if (!value) return fallback;
  return escapeForDiscord(value);
}

/**
 * Everything that will be submitted, spelled out.
 *
 * This is the list the approver is actually agreeing to, so it shows every
 * value the workflow will use — including the ones that were defaulted rather
 * than typed — and says explicitly when a password will be generated rather
 * than showing one.
 */
export function submittedValues(action: StructuredAction): APIEmbedField[] {
  switch (action.action) {
    case 'CREATE_ACCOUNT':
      return [
        field('First name', safe(action.firstName)),
        field('Last name', safe(action.lastName)),
        field('Email', safe(action.email)),
        field('Username', safe(action.username)),
        field('Role', safe(action.agentRole)),
        field('License', safe(action.licenseType)),
        field('Team', safe(action.team)),
        field('Campaign', safe(action.campaign)),
        field('Queue', safe(action.queue)),
        field('Active', action.active === false ? 'No' : 'Yes'),
        field(
          'Temporary password',
          action.temporaryPassword
            ? 'Supplied by an administrator, sent privately after the account is made'
            : 'Generated securely, sent privately after the account is made',
          false,
        ),
      ];
    case 'CLEAR_LICENSE':
      return [
        field('Agent', safe(describeTarget(action))),
        field(
          'On an active call',
          action.overrideActiveCall ? 'Override acknowledged by an admin' : 'Will stop if they are',
          false,
        ),
      ];
    case 'RESET_PASSWORD':
      return [
        field('Agent', safe(describeTarget(action))),
        field(
          'Temporary password',
          action.temporaryPassword
            ? 'Supplied by an administrator, sent privately after the reset'
            : 'Generated securely, sent privately after the reset',
          false,
        ),
      ];
    case 'DEACTIVATE_ACCOUNT':
      return [
        field('Agent', safe(describeTarget(action))),
        field('Reason', safe(action.reason), false),
      ];
    case 'CHECK_LICENSE_USAGE':
      return [field('License type', safe(action.licenseType, 'All'))];
    case 'CHECK_AGENT_STATUS':
      return [field('Agent', safe(describeTarget(action)))];
    case 'LIST_RECENT_ACTIONS':
      return [field('How many', String(action.limit)), field('Filter', action.status)];
  }
}

export function confirmationEmbed(input: {
  request: AutomationRequestRow;
  action: StructuredAction;
  requirement: ApprovalRequirement;
  requesterId: string;
  expiresAt: string;
  dryRun: boolean;
}): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(COLORS.pending)
    .setTitle(`Confirm: ${ACTION_LABELS[input.action.action]}`)
    .setDescription(
      [
        `**Target:** ${safe(describeTarget(input.action))}`,
        `**Requested by:** <@${input.requesterId}>`,
        input.requirement.independent
          ? '**This one needs a second pair of eyes.** Someone other than the requester, with owner or admin access, has to confirm it.'
          : '',
        input.dryRun
          ? '**Test mode is on.** I will check everything and stop before submitting, then tell you what would have happened.'
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .addFields(...submittedValues(input.action))
    .setFooter({
      text: `Request ${formatReference(input.request.reference)} • expires ${
        new Date(input.expiresAt).toISOString().slice(11, 16)
      } UTC`,
    })
    .setTimestamp(new Date(input.request.requested_at));

  embed.addFields(field('Expires', discordTimestamp(input.expiresAt, 'R'), false));
  return embed;
}

export function accountCreatedEmbed(input: {
  reference: number;
  account: ReadymodeAccount;
  completedAt: string;
  dryRun: boolean;
}): EmbedBuilder {
  const { account } = input;
  return new EmbedBuilder()
    .setColor(input.dryRun ? COLORS.warning : COLORS.success)
    .setTitle(input.dryRun ? 'Test run: the account was not created' : 'Account created successfully.')
    .setDescription(
      input.dryRun ? 'Everything checked out. Nothing was submitted because test mode is on.' : null,
    )
    .addFields(
      field('Agent', safe(account.fullName)),
      field('Username', safe(account.username)),
      field('Role', safe(account.agentRole)),
      field('License', safe(account.licenseType)),
      field('Campaign', safe(account.campaign)),
      field('Team', safe(account.team)),
      field('Completed at', discordTimestamp(input.completedAt, 'f'), false),
    )
    .setFooter({ text: `Request ${formatReference(input.reference)}` });
}

export function agentStatusEmbed(input: { reference: number; account: ReadymodeAccount }): EmbedBuilder {
  const { account } = input;
  return new EmbedBuilder()
    .setColor(account.active === false ? COLORS.neutral : COLORS.success)
    .setTitle(safe(account.fullName ?? account.username, 'Agent'))
    .addFields(
      field('Username', safe(account.username)),
      field('Email', safe(account.email)),
      field('Account', account.active === false ? 'Deactivated' : 'Active'),
      field('License', account.licenseInUse ? `In use (${safe(account.licenseType)})` : 'Not in use'),
      field('Signed in', account.loggedIn ? 'Yes' : 'No'),
      field('On a call', account.onCall ? 'Yes' : 'No'),
      field('Campaign', safe(account.campaign)),
      field('Team', safe(account.team)),
      field('Status', safe(account.statusText), false),
    )
    .setFooter({ text: `Request ${formatReference(input.reference)}` });
}

export function licenseUsageEmbed(input: {
  reference: number;
  usage: LicenseUsage;
  licenseType?: string;
}): EmbedBuilder {
  const { usage } = input;

  const lines = usage.holders
    .slice(0, 25)
    .map(
      (holder) =>
        `• ${safe(holder.fullName ?? holder.username)}` +
        `${holder.username ? ` (${safe(holder.username)})` : ''}` +
        `${holder.licenseType ? ` — ${safe(holder.licenseType)}` : ''}` +
        `${holder.onCall ? ' — on a call' : holder.loggedIn ? ' — signed in' : ''}`,
    );

  if (usage.holders.length > 25) {
    lines.push(`…and ${usage.holders.length - 25} more.`);
  }

  return new EmbedBuilder()
    .setColor(COLORS.neutral)
    .setTitle(
      input.licenseType
        ? `Agents using a ${escapeForDiscord(input.licenseType)} license`
        : 'Agents currently using licenses',
    )
    .setDescription(lines.length > 0 ? truncate(lines.join('\n'), 4000) : 'Nobody is holding a license right now.')
    .addFields(
      field('In use', usage.totalInUse === undefined ? String(usage.holders.length) : String(usage.totalInUse)),
      ...(usage.totalAvailable === undefined ? [] : [field('Accounts seen', String(usage.totalAvailable))]),
    )
    .setFooter({ text: `Request ${formatReference(input.reference)}` });
}

export function stateChangeEmbed(input: {
  reference: number;
  title: string;
  before: ReadymodeAccount;
  after: ReadymodeAccount;
  completedAt: string;
  dryRun: boolean;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(input.dryRun ? COLORS.warning : COLORS.success)
    .setTitle(input.dryRun ? `Test run: ${input.title.toLowerCase()} was not applied` : input.title)
    .addFields(
      field('Agent', safe(input.after.fullName ?? input.after.username)),
      field('License before', input.before.licenseInUse ? 'In use' : 'Not in use'),
      field('License after', input.after.licenseInUse ? 'In use' : 'Not in use'),
      field('Account', input.after.active === false ? 'Deactivated' : 'Active'),
      field('Completed at', discordTimestamp(input.completedAt, 'f'), false),
    )
    .setFooter({ text: `Request ${formatReference(input.reference)}` });
}

export function failureEmbed(input: {
  reference: number;
  message: string;
  detail?: string;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.failure)
    .setTitle('I could not complete that')
    .setDescription(truncate(input.message, 4000))
    .setFooter({ text: `Request ${formatReference(input.reference)}` });
}

export function recentActionsEmbed(input: {
  rows: AutomationRequestRow[];
  scopedToSelf: boolean;
}): EmbedBuilder {
  const lines = input.rows.map((row) => {
    const icon =
      row.status === 'COMPLETED' ? '✅' : row.status === 'FAILED' ? '❌' : row.status === 'CANCELLED' ? '⚪' : '⏳';
    const when = discordTimestamp(row.completed_at ?? row.requested_at, 'R');
    return (
      `${icon} \`${formatReference(row.reference)}\` **${ACTION_LABELS[row.action]}** — ` +
      `${safe(row.target_summary, 'no target')} · ${STATUS_LABELS[row.status]} · ${when}` +
      (row.dry_run && row.status === 'COMPLETED' ? ' _(test run)_' : '')
    );
  });

  return new EmbedBuilder()
    .setColor(COLORS.neutral)
    .setTitle(input.scopedToSelf ? 'Your recent requests' : 'Recent ReadySupport actions')
    .setDescription(lines.length > 0 ? truncate(lines.join('\n'), 4000) : 'Nothing yet.');
}

export function authWarningEmbed(detail?: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.failure)
    .setTitle('ReadySupport has lost access to Readymode')
    .setDescription(
      'No queued changes will run until an administrator reconnects the account.\n\n' +
        'Run `/reconnect_readymode` when you are ready to sign in again.',
    )
    .addFields(...(detail ? [field('Detail', safe(detail), false)] : []));
}

export function helpEmbed(input: { role: string; availableActions: string[]; nlChannelId?: string }): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.neutral)
    .setTitle('ReadySupport')
    .setDescription(
      'I handle Readymode admin work: making agent accounts, clearing licenses, resetting passwords and ' +
        'deactivating accounts, plus a few things you can just ask about.\n\n' +
        'Anything that changes Readymode gets shown to you for confirmation first, and everything is logged.',
    )
    .addFields(
      field('Your access', input.role, false),
      field(
        'Commands',
        [
          '`/create_account` — make a new agent account',
          '`/clear_license` — release the license an agent is holding',
          '`/reset_password` — set a new temporary password',
          '`/deactivate_account` — deactivate an account (needs a second approver)',
          '`/license_usage` — who is using licenses right now',
          '`/agent_status` — check one agent',
          '`/recent_actions` — what I have done lately',
          '`/login_status` — whether I can reach Readymode',
          '`/reconnect_readymode` — sign back in after the session expires',
          '`/help` — this message',
        ].join('\n'),
        false,
      ),
      field('What you can run', input.availableActions.join(', '), false),
      ...(input.nlChannelId
        ? [
            field(
              'Plain language',
              `In <#${input.nlChannelId}> you can just say what you need — for example ` +
                '"clear the license from John Brown" or "which agents are using licenses?". ' +
                'I will ask if anything is missing, and always confirm before changing anything.',
              false,
            ),
          ]
        : []),
      field(
        'Passwords',
        'I never post a password in a channel. Temporary passwords come back in a private reply only you can see.',
        false,
      ),
    );
}
