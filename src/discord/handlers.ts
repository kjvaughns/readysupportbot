import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  Events,
  Message,
  MessageFlags,
} from 'discord.js';
import { logger } from '../security/logger';
import { toSafeMessage } from '../security/errors';
import { recordEvent } from '../audit';
import { interpret } from '../openai';
import { getStore } from '../database';
import { commandToAction } from './commands';
import { resolveDiscordContext, ResolvedDiscordContext } from './context';
import { cancelRequest, confirmRequest, editRequestHint, handleAction, FlowReply } from './flow';
import { HELP_TEXT, parseButtonId } from './replies';

/**
 * Discord event handling.
 *
 * ReadySupport answers when it is mentioned, when someone replies to one of its
 * messages, when a slash command is used, and in channels an Owner marked for
 * automatic support. Everything else is ignored.
 */

export function registerHandlers(client: Client): void {
  client.on(Events.MessageCreate, (message) => {
    void onMessage(client, message).catch((error) =>
      logger.error({ err: error }, 'Message handler failed'),
    );
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isChatInputCommand()) {
      void onSlashCommand(interaction).catch((error) =>
        logger.error({ err: error }, 'Slash command handler failed'),
      );
      return;
    }
    if (interaction.isButton()) {
      void onButton(interaction).catch((error) =>
        logger.error({ err: error }, 'Button handler failed'),
      );
    }
  });
}

async function shouldRespond(client: Client, message: Message): Promise<boolean> {
  if (message.author.bot) return false;
  if (!message.guildId) return false;

  const botId = client.user?.id;
  if (botId && message.mentions.users.has(botId)) return true;

  // A reply to one of ReadySupport's own messages continues that conversation.
  if (message.reference?.messageId) {
    try {
      const referenced = await message.fetchReference();
      if (referenced.author.id === botId) return true;
    } catch {
      // The referenced message may be gone; fall through.
    }
  }

  const installation = await getStore().getInstallationByGuild(message.guildId);
  if (!installation) return false;

  const channels = await getStore().listChannels(installation.organizationId);
  const channel = channels.find((entry) => entry.channelId === message.channelId);

  // Automatic support channels answer without a mention, if mentions are not required.
  return Boolean(channel?.approved && channel.autoSupport && !installation.requireMention);
}

async function onMessage(client: Client, message: Message): Promise<void> {
  if (!(await shouldRespond(client, message))) return;

  const resolution = await resolveDiscordContext({
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id,
    memberRoleIds: message.member?.roles.cache.map((role) => role.id) ?? [],
  });

  if (resolution.status === 'rejected') {
    if (!resolution.quiet) await message.reply(resolution.reason);
    return;
  }

  const context = resolution.context;
  const botId = client.user?.id;
  const mentioned = botId ? message.mentions.users.has(botId) : false;

  if (context.requireMention && !mentioned) return;

  const text = stripMention(message.content, botId);
  if (!text.trim()) {
    await message.reply(HELP_TEXT);
    return;
  }

  const linked = await getStore().listLinkedAgentsForDiscordUser(
    context.organizationId,
    message.author.id,
  );

  const interpretation = await interpret({
    message: text,
    requesterDiscordUserId: message.author.id,
    hasLinkedAccount: linked.length === 1,
  });

  if (interpretation.flags.length > 0) {
    await recordEvent({
      organizationId: context.organizationId,
      type: 'prompt_injection.blocked',
      message: 'Instruction-like content in a Discord message was neutralized before parsing.',
      data: { flags: interpretation.flags, discordUserId: message.author.id },
    });
  }

  if (interpretation.status !== 'ok' || !interpretation.action) {
    await message.reply(
      interpretation.message ?? 'I could not turn that into a supported ReadySupport action.',
    );
    return;
  }

  const reply = await handleAction({
    context,
    action: interpretation.action,
    messageId: message.id,
  });

  await sendReply(message, reply);
}

function stripMention(content: string, botId?: string): string {
  if (!botId) return content;
  return content.replace(new RegExp(`<@!?${botId}>`, 'g'), ' ').trim();
}

async function sendReply(message: Message, reply: FlowReply): Promise<void> {
  await message.reply({
    content: reply.content.slice(0, 1900),
    ...(reply.components ? { components: reply.components } : {}),
  });
}

async function onSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const resolution = await resolveDiscordContext({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    memberRoleIds:
      interaction.inCachedGuild() && interaction.member
        ? interaction.member.roles.cache.map((role) => role.id)
        : [],
    isCommand: true,
  });

  if (resolution.status === 'rejected') {
    await interaction.reply({ content: resolution.reason, flags: MessageFlags.Ephemeral });
    return;
  }

  const parsed = commandToAction(interaction);
  if (parsed.status !== 'ok' || !parsed.action) {
    await interaction.reply({
      content: parsed.message ?? 'That command could not be validated.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  try {
    const reply = await handleAction({ context: resolution.context, action: parsed.action });
    await interaction.editReply({
      content: reply.content.slice(0, 1900),
      ...(reply.components ? { components: reply.components } : {}),
    });
  } catch (error) {
    logger.error({ err: error }, 'Slash command failed');
    await interaction.editReply({ content: toSafeMessage(error) });
  }
}

async function onButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseButtonId(interaction.customId);
  if (!parsed) return;

  const resolution = await resolveDiscordContext({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    memberRoleIds:
      interaction.inCachedGuild() && interaction.member
        ? interaction.member.roles.cache.map((role) => role.id)
        : [],
    isCommand: true,
  });

  if (resolution.status === 'rejected') {
    await interaction.reply({ content: resolution.reason, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();
  const context: ResolvedDiscordContext = resolution.context;

  try {
    let reply: FlowReply;
    if (parsed.action === 'confirm') {
      reply = await confirmRequest({ requestId: parsed.requestId, context });
    } else if (parsed.action === 'cancel') {
      reply = await cancelRequest({ requestId: parsed.requestId, context });
    } else {
      reply = await editRequestHint(parsed.requestId);
    }

    await interaction.editReply({
      content: reply.content.slice(0, 1900),
      ...(reply.components ? { components: reply.components } : {}),
    });
  } catch (error) {
    logger.error({ err: error }, 'Button interaction failed');
    await interaction.editReply({ content: toSafeMessage(error) });
  }
}
