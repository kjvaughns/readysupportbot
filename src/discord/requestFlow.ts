import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type RepliableInteraction,
} from 'discord.js';
import { env } from '../config/env.js';
import {
  describeTarget,
  isMutating,
  type StructuredAction,
} from '../domain/actions.js';
import { canViewAllRequests } from '../domain/roles.js';
import { toReadySupportError } from '../domain/errors.js';
import type { Principal } from '../auth/authorize.js';
import { approvalRequirementFor, deliversCredentials } from '../auth/permissions.js';
import * as requests from '../db/repositories/requests.js';
import type { RequestSource } from '../db/types.js';
import * as audit from '../audit/audit.js';
import * as approvals from '../approvals/service.js';
import * as vault from '../security/secretVault.js';
import { registerSecret } from '../security/redact.js';
import { confirmationEmbed, failureEmbed, recentActionsEmbed } from './embeds.js';
import { encodeComponentId } from './customIds.js';
import * as replies from './replyRegistry.js';
import { moduleLogger } from '../util/logger.js';

/**
 * The single path every request travels.
 *
 * Slash commands and natural language both end up here with a validated
 * StructuredAction, so there is exactly one place where the decision "does
 * this need confirming?" is made, and no way to add a command that skips it.
 */

const log = moduleLogger('request-flow');

export interface SubmitInput {
  interaction: RepliableInteraction;
  principal: Principal;
  action: StructuredAction;
  source: RequestSource;
  /** The original message, for the audit trail. Sanitized before storage. */
  requestText?: string;
  /**
   * A password an administrator typed. Held in memory only for the life of the
   * request; never written to the database.
   */
  providedPassword?: string;
}

/** LIST_RECENT_ACTIONS is answered from the audit log, not from a browser. */
async function answerRecentActions(input: SubmitInput): Promise<void> {
  const action = input.action;
  if (action.action !== 'LIST_RECENT_ACTIONS') return;

  const scopedToSelf = !canViewAllRequests(input.principal.role);

  const rows = await requests.listRecent({
    limit: action.limit,
    ...(scopedToSelf ? { requesterDiscordId: input.principal.discordUserId } : {}),
    ...(action.status === 'ALL' ? {} : { statuses: [action.status] }),
  });

  await input.interaction.editReply({
    embeds: [recentActionsEmbed({ rows, scopedToSelf })],
  });

  await audit.recordSystemEvent('REQUEST_CREATED', {
    discordUserId: input.principal.discordUserId,
    userRole: input.principal.role,
    action: 'LIST_RECENT_ACTIONS',
    status: 'COMPLETED',
    metadata: { returned: rows.length, scopedToSelf },
  });
}

/**
 * Create the request, then either queue it or open an approval.
 *
 * The interaction must already be deferred; every branch here can take longer
 * than Discord's three-second window.
 */
export async function submit(input: SubmitInput): Promise<void> {
  const { interaction, principal, action } = input;

  if (action.action === 'LIST_RECENT_ACTIONS') {
    await answerRecentActions(input);
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply({ content: 'ReadySupport only works inside a server channel.' });
    return;
  }

  const mutating = isMutating(action.action);
  const dryRun = mutating && env().READYSUPPORT_MODE === 'dry_run';
  const ephemeral = deliversCredentials(action.action);

  const request = await requests.create({
    action: action.action,
    source: input.source,
    guildId,
    channelId: interaction.channelId ?? '',
    requesterDiscordId: principal.discordUserId,
    requesterBotUserId: principal.botUserId,
    requesterRole: principal.role,
    status: 'PENDING',
    input: action,
    targetSummary: describeTarget(action),
    targetRef: 'target' in action ? (action.target as Record<string, unknown>) : {},
    dryRun,
    ...(input.requestText ? { requestText: input.requestText } : {}),
  });

  await audit.recordForRequest(request, 'REQUEST_CREATED', {
    newState: { action: action.action, target: describeTarget(action) },
    metadata: { source: input.source, dryRun },
  });

  // A password typed by an administrator goes to the in-memory vault, keyed by
  // the request, and is picked up when the job runs. It is never persisted.
  if (input.providedPassword) {
    registerSecret(input.providedPassword);
    vault.put(vault.keys.providedPassword(request.id), input.providedPassword);
  }

  replies.remember(request.id, {
    interaction,
    channelId: interaction.channelId ?? '',
    ephemeral,
    requesterDiscordId: principal.discordUserId,
  });

  if (!mutating) {
    // Read-only. Nothing to confirm, so it goes straight into the queue and
    // the result replaces this reply when it lands.
    await requests.update(request.id, { status: 'APPROVED', approvedAt: new Date().toISOString() }, 'PENDING');
    await audit.recordForRequest(request, 'QUEUED');
    await interaction.editReply({ content: 'Checking Readymode…' });
    return;
  }

  const requirement = approvalRequirementFor(action);
  const awaiting = await requests.update(request.id, { status: 'AWAITING_APPROVAL' }, 'PENDING');

  let handle;
  try {
    handle = await approvals.requestApproval(awaiting, action);
  } catch (cause) {
    const error = toReadySupportError(cause);
    log.error({ err: cause, requestId: request.id }, 'Could not open an approval');
    await requests.update(request.id, {
      status: 'FAILED',
      errorCategory: error.category,
      errorMessage: error.userMessage,
      completedAt: new Date().toISOString(),
    });
    await interaction.editReply({
      embeds: [failureEmbed({ reference: request.reference, message: error.userMessage })],
    });
    return;
  }

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeComponentId({ kind: 'approve', requestId: request.id, nonce: handle.nonce }))
      .setLabel(dryRun ? 'Confirm (test run)' : 'Confirm')
      .setStyle(requirement.independent ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(encodeComponentId({ kind: 'cancel', requestId: request.id, nonce: handle.nonce }))
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );

  const message = await interaction.editReply({
    content: requirement.independent
      ? 'This needs confirming by someone other than the person who asked.'
      : '',
    embeds: [
      confirmationEmbed({
        request: awaiting,
        action,
        requirement,
        requesterId: principal.discordUserId,
        expiresAt: handle.expiresAt,
        dryRun,
      }),
    ],
    components: [buttons],
  });

  await requests.update(request.id, { interactionMessageId: message.id });
}

/** Ask for information that is missing, without creating a request yet. */
export async function askForMoreInformation(input: {
  interaction: RepliableInteraction;
  question: string;
}): Promise<void> {
  await input.interaction.editReply({
    content: input.question,
  });
}

/** Standard refusal reply. Ephemeral so a refusal is not a public event. */
export async function refuse(interaction: RepliableInteraction, message: string): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content: message });
    return;
  }
  await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}
