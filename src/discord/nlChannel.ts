import { MessageFlags, type Message } from 'discord.js';
import { env } from '../config/env.js';
import { authorize } from '../auth/authorize.js';
import { interpret } from '../nlp/interpret.js';
import { toReadySupportError } from '../domain/errors.js';
import * as audit from '../audit/audit.js';
import * as notifier from '../notify/notifier.js';
import { submit } from './requestFlow.js';
import { moduleLogger } from '../util/logger.js';
import { escapeForDiscord } from '../util/text.js';

/**
 * Free-form requests in the one designated channel.
 *
 * The message is treated as untrusted text throughout: it is cleaned, it is
 * fenced as data in the prompt, and what comes back is a structured action that
 * goes through exactly the same permission check and confirmation step as a
 * slash command. Nothing about this path is a shortcut around the other one.
 */

const log = moduleLogger('nl-channel');

/**
 * A message interaction has no reply token, so the shared submission path is
 * given an adapter that behaves like a deferred interaction and edits a real
 * message instead.
 */
interface MessageReplyAdapter {
  deferred: boolean;
  replied: boolean;
  guildId: string | null;
  channelId: string;
  user: { id: string };
  ephemeral: boolean;
  editReply(payload: unknown): Promise<{ id: string }>;
  followUp(payload: unknown): Promise<{ id: string }>;
  reply(payload: unknown): Promise<{ id: string }>;
}

function adapt(message: Message, placeholder: Message): MessageReplyAdapter {
  return {
    deferred: true,
    replied: true,
    guildId: message.guildId,
    channelId: message.channelId,
    user: { id: message.author.id },
    ephemeral: false,
    async editReply(payload: unknown) {
      const edited = await placeholder.edit(payload as never);
      return { id: edited.id };
    },
    async followUp(payload: unknown) {
      const sent = await message.reply(payload as never);
      return { id: sent.id };
    },
    async reply(payload: unknown) {
      const sent = await message.reply(payload as never);
      return { id: sent.id };
    },
  };
}

/** True when this message should be looked at at all. */
export function shouldHandle(message: Message): boolean {
  if (message.author.bot) return false;
  if (!message.guildId) return false;

  const channelId = env().DISCORD_NL_CHANNEL_ID;
  if (!channelId) return false;
  if (message.channelId !== channelId) return false;

  return message.content.trim().length > 0;
}

export async function handleMessage(message: Message): Promise<void> {
  if (!shouldHandle(message)) return;

  // The channel allow-list is still consulted even though the id matched the
  // configured one: the database is what actually grants a channel, and an
  // environment variable pointing at a channel nobody approved is not enough.
  const decision = await authorize({
    discordUserId: message.author.id,
    discordUsername: message.author.username,
    guildId: message.guildId,
    channelId: message.channelId,
    purpose: 'NATURAL_LANGUAGE',
    budget: 'nl',
  });

  if (!decision.ok) {
    if (decision.suspicious) {
      await notifier.alertUnauthorizedRequest({
        discordUserId: message.author.id,
        guildId: message.guildId,
        channelId: message.channelId,
        attempted: 'natural language request',
        reason: decision.error.category,
      });
      await audit.recordSystemEvent('PERMISSION_DENIED', {
        discordUserId: message.author.id,
        errorCategory: decision.error.category,
        errorMessage: decision.error.userMessage,
        metadata: { channelId: message.channelId, source: 'NATURAL_LANGUAGE' },
      });
    }

    await message.reply({ content: decision.error.userMessage });
    return;
  }

  const principal = decision.principal;
  const placeholder = await message.reply({ content: 'Reading that…' });

  try {
    const interpretation = await interpret({
      text: message.content,
      role: principal.role,
    });

    switch (interpretation.kind) {
      case 'blocked': {
        await placeholder.edit({ content: interpretation.message });
        await audit.recordSystemEvent('PERMISSION_DENIED', {
          discordUserId: principal.discordUserId,
          userRole: principal.role,
          errorCategory: 'VALIDATION_FAILED',
          errorMessage: 'A natural language message was refused before interpretation.',
          metadata: { source: 'NATURAL_LANGUAGE' },
        });
        return;
      }

      case 'unsupported': {
        await placeholder.edit({ content: escapeForDiscord(interpretation.message, 1_500) });
        return;
      }

      case 'need_more_info': {
        // Deliberately does not create a request. A half-understood intention
        // is not a pending job; the person answers and asks again.
        await placeholder.edit({
          content: escapeForDiscord(interpretation.question, 1_500),
        });
        await audit.recordSystemEvent('INFORMATION_REQUESTED', {
          discordUserId: principal.discordUserId,
          userRole: principal.role,
          action: interpretation.action,
          metadata: { missing: interpretation.missing, source: 'NATURAL_LANGUAGE' },
        });
        return;
      }

      case 'action': {
        await submit({
          interaction: adapt(message, placeholder) as never,
          principal,
          action: interpretation.action,
          source: 'NATURAL_LANGUAGE',
          requestText: message.content,
        });
        return;
      }
    }
  } catch (cause) {
    const error = toReadySupportError(cause);
    log.warn({ err: cause, userId: principal.discordUserId }, 'Could not handle a natural language request');
    await placeholder.edit({ content: error.userMessage }).catch(() => undefined);
  }
}

/** Used by the ephemeral refusal path in tests. */
export const EPHEMERAL = MessageFlags.Ephemeral;
