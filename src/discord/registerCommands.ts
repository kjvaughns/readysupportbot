import { REST, Routes } from 'discord.js';
import { env } from '../config';
import { logger } from '../security/logger';
import { commandBuilders } from './commands';

/**
 * Registers slash commands with Discord. Run once after deploying, or whenever
 * the command list changes:
 *
 *   npm run register:commands              (global)
 *   GUILD_ID=... npm run register:commands (single guild, applies immediately)
 */
export async function registerCommands(guildId?: string): Promise<number> {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_CLIENT_ID) {
    throw new Error('DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID are required to register commands.');
  }

  const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);
  const body = commandBuilders.map((builder) => builder.toJSON());

  const route = guildId
    ? Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, guildId)
    : Routes.applicationCommands(env.DISCORD_CLIENT_ID);

  await rest.put(route, { body });
  return body.length;
}

if (require.main === module) {
  registerCommands(process.env.GUILD_ID)
    .then((count) => {
      logger.info({ count, guildId: process.env.GUILD_ID ?? 'global' }, 'Slash commands registered');
      process.exit(0);
    })
    .catch((error) => {
      logger.error({ err: error }, 'Failed to register slash commands');
      process.exit(1);
    });
}
