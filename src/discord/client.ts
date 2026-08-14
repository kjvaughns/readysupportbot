import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import { env } from '../config/env.js';
import { authorize } from '../auth/authorize.js';
import { toReadySupportError } from '../domain/errors.js';
import * as audit from '../audit/audit.js';
import * as notifier from '../notify/notifier.js';
import { findCommand } from './commands/index.js';
import { handleAccountChoice, handleButton, handleModalSubmit } from './interactions.js';
import { handleMessage } from './nlChannel.js';
import { moduleLogger } from '../util/logger.js';

/**
 * The Discord gateway client and the routing that sits on top of it.
 *
 * Every interaction goes through the same three steps before any command code
 * runs: authorize, defer, then dispatch. Doing this once here rather than in
 * each command means a new command cannot accidentally be written without a
 * permission check.
 */

const log = moduleLogger('discord');

export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      // Needed to read free-form requests in the designated channel. If the
      // message content intent is not enabled for the application, slash
      // commands still work and only that channel goes quiet.
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });
}

export function registerHandlers(client: Client): void {
  client.once(Events.ClientReady, (ready) => {
    log.info({ user: ready.user.tag, guilds: ready.guilds.cache.size }, 'Connected to Discord');
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void route(interaction).catch((cause) => {
      log.error({ err: cause }, 'Unhandled error while routing an interaction');
    });
  });

  client.on(Events.MessageCreate, (message) => {
    void handleMessage(message).catch((cause) => {
      log.error({ err: cause }, 'Unhandled error while handling a message');
    });
  });

  client.on(Events.Error, (error) => {
    log.error({ err: error }, 'Discord client error');
  });

  client.on(Events.Warn, (message) => {
    log.warn({ message }, 'Discord client warning');
  });
}

async function route(interaction: Interaction): Promise<void> {
  if (interaction.isChatInputCommand()) {
    await routeCommand(interaction);
    return;
  }
  if (interaction.isButton()) {
    await handleButton(interaction);
    return;
  }
  if (interaction.isStringSelectMenu()) {
    await handleAccountChoice(interaction);
    return;
  }
  if (interaction.isModalSubmit()) {
    await handleModalSubmit(interaction);
    return;
  }
}

async function routeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const command = findCommand(interaction.commandName);

  if (!command) {
    await interaction.reply({
      content: 'I do not know that command. Try `/help`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const decision = await authorize({
    discordUserId: interaction.user.id,
    discordUsername: interaction.user.username,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    purpose: 'COMMANDS',
    ...(command.action ? { action: command.action } : {}),
    budget: command.budget,
  });

  if (!decision.ok) {
    await interaction.reply({
      content: decision.error.userMessage,
      flags: MessageFlags.Ephemeral,
    });

    await audit.recordSystemEvent(
      decision.error.category === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'PERMISSION_DENIED',
      {
        discordUserId: interaction.user.id,
        ...(command.action ? { action: command.action } : {}),
        errorCategory: decision.error.category,
        errorMessage: decision.error.userMessage,
        metadata: { command: command.name, channelId: interaction.channelId },
      },
    );

    if (decision.suspicious) {
      await notifier.alertUnauthorizedRequest({
        discordUserId: interaction.user.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        attempted: `/${command.name}`,
        reason: decision.error.category,
      });
    }
    return;
  }

  // Every command can take longer than Discord's three second window: they all
  // talk to the database, and most of them queue a job.
  await interaction.deferReply(command.ephemeral ? { flags: MessageFlags.Ephemeral } : {});

  try {
    await command.handle({ interaction, principal: decision.principal });
  } catch (cause) {
    const error = toReadySupportError(cause);
    log.error(
      { err: cause, command: command.name, userId: interaction.user.id },
      'A command failed',
    );

    await interaction
      .editReply({ content: error.userMessage })
      .catch(() => undefined);
  }
}

export async function login(client: Client): Promise<void> {
  await client.login(env().DISCORD_BOT_TOKEN);
}
