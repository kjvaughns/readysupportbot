import { logger } from '../security/logger';
import { registerHandlers } from './handlers';
import { isDiscordConfigured, startClient, stopClient } from './client';

export * from './client';
export * from './context';
export * from './flow';
export { commandBuilders, COMMAND_NAMES, commandToAction } from './commands';

/**
 * Starts the bot when it is configured. A missing token is not an error: the
 * HTTP server keeps running and /ready reports Discord as unconfigured.
 */
export async function startDiscord(): Promise<void> {
  if (!isDiscordConfigured()) {
    logger.warn('Discord bot token is missing. Running in setup mode without the bot.');
    return;
  }

  const client = await startClient();
  if (!client) return;

  registerHandlers(client);
  logger.info('Discord handlers registered');
}

export async function stopDiscord(): Promise<void> {
  await stopClient();
}
