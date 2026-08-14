import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { env } from '../config';
import { logger } from '../security/logger';

/**
 * Discord gateway client.
 *
 * The bot is optional at boot: if the token is missing the service still starts
 * and reports Discord as unconfigured through /ready.
 */

let client: Client | null = null;
let ready = false;
let lastError: string | null = null;

export function isDiscordConfigured(): boolean {
  return Boolean(env.DISCORD_BOT_TOKEN && env.DISCORD_CLIENT_ID);
}

export function getClient(): Client | null {
  return client;
}

export function discordStatus(): {
  configured: boolean;
  ready: boolean;
  guilds: number;
  error?: string | null;
} {
  return {
    configured: isDiscordConfigured(),
    ready,
    guilds: client?.guilds?.cache?.size ?? 0,
    error: lastError,
  };
}

export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel],
  });
}

export async function startClient(): Promise<Client | null> {
  if (!isDiscordConfigured()) {
    logger.warn('Discord is not configured. The bot will not connect (setup mode).');
    return null;
  }
  if (client) return client;

  client = createClient();

  client.once('clientReady', () => {
    ready = true;
    lastError = null;
    logger.info({ guilds: client?.guilds.cache.size ?? 0 }, 'Discord client ready');
  });

  client.on('error', (error) => {
    lastError = error.message;
    logger.error({ err: error }, 'Discord client error');
  });

  client.on('shardDisconnect', () => {
    ready = false;
    logger.warn('Discord shard disconnected');
  });

  client.on('shardResume', () => {
    ready = true;
    logger.info('Discord shard resumed');
  });

  try {
    await client.login(env.DISCORD_BOT_TOKEN!);
  } catch (error) {
    ready = false;
    lastError = error instanceof Error ? error.message : 'Login failed.';
    logger.error({ err: error }, 'Discord login failed; continuing in setup mode');
    client = null;
    return null;
  }

  return client;
}

export async function stopClient(): Promise<void> {
  if (!client) return;
  await client.destroy().catch(() => undefined);
  client = null;
  ready = false;
}

export async function checkDiscord(): Promise<{ ok: boolean; detail?: string }> {
  if (!isDiscordConfigured()) {
    return { ok: false, detail: 'DISCORD_BOT_TOKEN / DISCORD_CLIENT_ID are not set.' };
  }
  if (!client || !ready) {
    return { ok: false, detail: lastError ?? 'The gateway connection is not ready.' };
  }
  return { ok: true };
}
