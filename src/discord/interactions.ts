import {
  MessageFlags,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { structuredActionSchema, type StructuredAction } from '../domain/actions.js';
import { resolvePrincipal } from '../auth/authorize.js';
import * as approvals from '../approvals/service.js';
import * as requests from '../db/repositories/requests.js';
import { decodeComponentId } from './customIds.js';
import { submit } from './requestFlow.js';
import * as replies from './replyRegistry.js';
import { moduleLogger } from '../util/logger.js';
import { escapeForDiscord } from '../util/text.js';

/**
 * Button and menu handling.
 *
 * The identity that matters here is the person who *clicked*, not the person
 * who ran the original command. That distinction is the whole point of the
 * second-approver rule, so the principal is resolved fresh from the database
 * on every click.
 */

const log = moduleLogger('interactions');

export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const id = decodeComponentId(interaction.customId);
  if (!id) return;

  const principal = await resolvePrincipal(interaction.user.id);
  if (!principal) {
    await interaction.reply({
      content: 'You are not set up to use ReadySupport.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  switch (id.kind) {
    case 'approve':
      await handleApprove(interaction, id.requestId, id.nonce, principal);
      return;
    case 'cancel':
      await handleCancel(interaction, id.requestId, id.nonce, principal);
      return;
    default:
      log.debug({ kind: id.kind }, 'Unhandled button kind');
  }
}

type Principal = NonNullable<Awaited<ReturnType<typeof resolvePrincipal>>>;

async function handleApprove(
  interaction: ButtonInteraction,
  requestId: string,
  nonce: string,
  principal: Principal,
): Promise<void> {
  await interaction.deferUpdate();

  const outcome = await approvals.confirm({ requestId, nonce, actor: principal });

  if (!outcome.ok) {
    await interaction.followUp({ content: outcome.reason, flags: MessageFlags.Ephemeral });

    // An expired or already-decided approval leaves live buttons on screen.
    // Clearing them stops a second person clicking something that will not
    // work and wondering why.
    if (outcome.category === 'EXPIRED' || outcome.category === 'ALREADY_DECIDED') {
      await interaction.editReply({ components: [] }).catch(() => undefined);
    }
    return;
  }

  // The reply that carried the buttons becomes the place the result lands, so
  // the whole exchange stays in one message.
  replies.remember(outcome.request.id, {
    interaction,
    channelId: interaction.channelId,
    ephemeral: interaction.ephemeral ?? false,
    requesterDiscordId: outcome.request.requester_discord_id,
  });

  await interaction.editReply({
    content:
      outcome.request.requester_discord_id === principal.discordUserId
        ? 'Confirmed. Working on it…'
        : `Confirmed by <@${principal.discordUserId}>. Working on it…`,
    components: [],
  });
}

async function handleCancel(
  interaction: ButtonInteraction,
  requestId: string,
  nonce: string,
  principal: Principal,
): Promise<void> {
  await interaction.deferUpdate();

  const outcome = await approvals.cancel({ requestId, nonce, actor: principal });

  if (!outcome.ok) {
    await interaction.followUp({ content: outcome.reason, flags: MessageFlags.Ephemeral });
    return;
  }

  replies.forget(requestId);

  await interaction.editReply({
    content: `Cancelled by <@${principal.discordUserId}>. Nothing was changed.`,
    embeds: [],
    components: [],
  });
}

/**
 * Picking one account from several.
 *
 * When a search matched more than one person the workflow stopped without
 * acting and asked. The chosen account comes back as its strongest identifier,
 * which is then used to build a fresh request — the ambiguous one stays failed
 * in the audit trail rather than being quietly rewritten.
 */
export async function handleAccountChoice(interaction: StringSelectMenuInteraction): Promise<void> {
  const id = decodeComponentId(interaction.customId);
  if (!id || id.kind !== 'pick_account') return;

  const principal = await resolvePrincipal(interaction.user.id);
  if (!principal) {
    await interaction.reply({
      content: 'You are not set up to use ReadySupport.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const original = await requests.findById(id.requestId);
  if (!original) {
    await interaction.reply({ content: 'I could not find that request any more.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Only the person who asked may resolve their own ambiguity. Anyone else
  // choosing on their behalf would put someone else's name on the request.
  if (original.requester_discord_id !== principal.discordUserId) {
    await interaction.reply({
      content: 'Only the person who made this request can pick which account it meant.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const chosen = interaction.values[0];
  if (!chosen) return;

  const target = refFromCandidateKey(chosen);
  if (!target) {
    await interaction.reply({ content: 'That choice was not one I offered.', flags: MessageFlags.Ephemeral });
    return;
  }

  const rebuilt = structuredActionSchema.safeParse({
    ...original.input,
    action: original.action,
    target,
  });

  if (!rebuilt.success) {
    await interaction.reply({
      content: 'I could not rebuild that request. Please run the command again with the exact username.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply({
    content: `Using ${escapeForDiscord(describeChoice(target))}.`,
  });

  await submit({
    interaction,
    principal,
    action: rebuilt.data as StructuredAction,
    source: original.source,
  });
}

/** Reverse of matching.candidateKey. */
export function refFromCandidateKey(
  key: string,
): { readymodeUserId?: string; username?: string; email?: string; fullName?: string } | undefined {
  const separator = key.indexOf(':');
  if (separator < 0) return undefined;

  const kind = key.slice(0, separator);
  const value = key.slice(separator + 1);
  if (!value) return undefined;

  switch (kind) {
    case 'id':
      return { readymodeUserId: value };
    case 'user':
      return { username: value };
    case 'mail':
      return { email: value };
    case 'name':
      return { fullName: value };
    default:
      return undefined;
  }
}

function describeChoice(ref: {
  readymodeUserId?: string;
  username?: string;
  email?: string;
  fullName?: string;
}): string {
  return ref.username ?? ref.email ?? ref.readymodeUserId ?? ref.fullName ?? 'that account';
}
