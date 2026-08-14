import { loadEnv } from '../src/config/env.js';
import * as botUsers from '../src/db/repositories/botUsers.js';
import * as approvedPlaces from '../src/db/repositories/approvedPlaces.js';
import type { ChannelPurpose } from '../src/db/types.js';

/**
 * Bootstrap the first owner and the allow-lists.
 *
 * Nobody can use ReadySupport until a row exists in bot_users, and the bot has
 * no command for adding the first one — a bot that can grant itself its own
 * first administrator is a bot with no meaningful access control at all. This
 * script is the deliberate, out-of-band way in, run by whoever owns the
 * database credentials.
 *
 *   npm run seed:owner -- --discord-id 123456789012345678 \
 *                         --commands-channel 234567890123456789 \
 *                         --nl-channel 345678901234567890 \
 *                         --alerts-channel 456789012345678901
 *
 * Only --discord-id is required; the guild comes from DISCORD_GUILD_ID.
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

const SNOWFLAKE = /^\d{15,25}$/;

async function main(): Promise<void> {
  const env = loadEnv();

  const discordId = arg('discord-id');
  if (!discordId || !SNOWFLAKE.test(discordId)) {
    throw new Error(
      'Pass --discord-id with your Discord user ID (enable Developer Mode, right-click yourself, Copy User ID).',
    );
  }

  await approvedPlaces.upsertGuild({
    guildId: env.DISCORD_GUILD_ID,
    name: 'Seeded at setup',
    createdBy: discordId,
  });
  process.stdout.write(`Approved guild ${env.DISCORD_GUILD_ID}.\n`);

  const channels: Array<{ flag: string; purpose: ChannelPurpose }> = [
    { flag: 'commands-channel', purpose: 'COMMANDS' },
    { flag: 'nl-channel', purpose: 'NATURAL_LANGUAGE' },
    { flag: 'alerts-channel', purpose: 'ALERTS' },
  ];

  for (const { flag, purpose } of channels) {
    const channelId = arg(flag) ?? (purpose === 'NATURAL_LANGUAGE' ? env.DISCORD_NL_CHANNEL_ID : undefined);
    if (!channelId) continue;

    if (!SNOWFLAKE.test(channelId)) {
      throw new Error(`--${flag} must be a Discord channel ID`);
    }

    await approvedPlaces.upsertChannel({
      guildId: env.DISCORD_GUILD_ID,
      channelId,
      purpose,
      createdBy: discordId,
    });
    process.stdout.write(`Approved channel ${channelId} for ${purpose}.\n`);
  }

  const existing = await botUsers.findByDiscordId(discordId);
  await botUsers.upsert({
    discordUserId: discordId,
    role: 'OWNER',
    active: true,
    notes: 'Seeded during setup',
    createdBy: 'seed-owner script',
  });

  process.stdout.write(
    existing
      ? `Updated ${discordId} to OWNER.\n`
      : `Added ${discordId} as OWNER.\n`,
  );
  process.stdout.write('\nNow run: npm run register\n');
}

main().catch((cause) => {
  process.stderr.write(`Seeding failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(1);
});
