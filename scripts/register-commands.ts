import { REST, Routes } from 'discord.js';
import { loadEnv } from '../src/config/env.js';
import { commandPayloads, COMMANDS } from '../src/discord/commands/index.js';

/**
 * Register slash commands with Discord.
 *
 * Guild-scoped rather than global: guild commands appear immediately, global
 * ones can take an hour to propagate, and a tool that administers real accounts
 * has no business being installable in servers nobody approved.
 *
 *   npm run register
 *   npm run register -- --clear    remove every command from the guild
 */

async function main(): Promise<void> {
  const env = loadEnv();
  const clear = process.argv.includes('--clear');

  const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);
  const route = Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID);

  if (clear) {
    await rest.put(route, { body: [] });
    process.stdout.write(`Removed all ReadySupport commands from guild ${env.DISCORD_GUILD_ID}.\n`);
    return;
  }

  const body = commandPayloads();
  await rest.put(route, { body });

  process.stdout.write(
    `Registered ${body.length} commands with guild ${env.DISCORD_GUILD_ID}:\n` +
      COMMANDS.map((command) => `  /${command.name}`).join('\n') +
      '\n',
  );
}

main().catch((cause) => {
  process.stderr.write(
    `Could not register commands: ${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  process.exit(1);
});
