import { db, unwrap, unwrapMaybe } from '../client.js';
import type { BotRole } from '../../domain/roles.js';
import type { BotUserRow } from '../types.js';

const TABLE = 'bot_users';

/** Look up a Discord user's internal role. Inactive users resolve to null. */
export async function findActiveByDiscordId(discordUserId: string): Promise<BotUserRow | null> {
  return unwrapMaybe<BotUserRow>(
    await db().from(TABLE).select('*').eq('discord_user_id', discordUserId).eq('active', true).maybeSingle(),
    'botUsers.findActiveByDiscordId',
  );
}

/** Includes deactivated users, for the permission management view. */
export async function findByDiscordId(discordUserId: string): Promise<BotUserRow | null> {
  return unwrapMaybe<BotUserRow>(
    await db().from(TABLE).select('*').eq('discord_user_id', discordUserId).maybeSingle(),
    'botUsers.findByDiscordId',
  );
}

export async function listByRole(role: BotRole): Promise<BotUserRow[]> {
  return unwrap<BotUserRow[]>(
    await db().from(TABLE).select('*').eq('role', role).eq('active', true).order('created_at'),
    'botUsers.listByRole',
  );
}

export async function listAll(): Promise<BotUserRow[]> {
  return unwrap<BotUserRow[]>(
    await db().from(TABLE).select('*').order('role').order('created_at'),
    'botUsers.listAll',
  );
}

/** Everyone who should receive OWNER alerts. */
export async function listOwners(): Promise<BotUserRow[]> {
  return listByRole('OWNER');
}

export interface UpsertBotUserInput {
  discordUserId: string;
  discordUsername?: string | null;
  role: BotRole;
  active?: boolean;
  notes?: string | null;
  createdBy?: string | null;
}

export async function upsert(input: UpsertBotUserInput): Promise<BotUserRow> {
  const rows = unwrap<BotUserRow[]>(
    await db()
      .from(TABLE)
      .upsert(
        {
          discord_user_id: input.discordUserId,
          discord_username: input.discordUsername ?? null,
          role: input.role,
          active: input.active ?? true,
          notes: input.notes ?? null,
          created_by: input.createdBy ?? null,
        },
        { onConflict: 'discord_user_id' },
      )
      .select('*'),
    'botUsers.upsert',
  );

  const row = rows[0];
  if (!row) throw new Error('bot_users upsert returned no row');
  return row;
}

/** Revoke access without deleting the history of what they did. */
export async function deactivate(discordUserId: string): Promise<void> {
  unwrap<BotUserRow[]>(
    await db().from(TABLE).update({ active: false }).eq('discord_user_id', discordUserId).select('*'),
    'botUsers.deactivate',
  );
}
