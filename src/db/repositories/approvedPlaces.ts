import { db, unwrap, unwrapMaybe } from '../client.js';
import type { ApprovedChannelRow, ApprovedGuildRow, ChannelPurpose } from '../types.js';

/**
 * Guild and channel allow-lists.
 *
 * Reads are cached briefly. The bot handles every message in a natural
 * language channel, and hitting the database on each one to ask "is this
 * channel approved?" would be wasteful; a short TTL keeps revocation quick
 * without that cost.
 */

const GUILDS = 'approved_guilds';
const CHANNELS = 'approved_channels';
const CACHE_TTL_MS = 30_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const guildCache = new Map<string, CacheEntry<boolean>>();
const channelCache = new Map<string, CacheEntry<boolean>>();

function cached<T>(store: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

function remember<T>(store: Map<string, CacheEntry<T>>, key: string, value: T): T {
  store.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Drop the caches — used after a change and by tests. */
export function clearAllowListCache(): void {
  guildCache.clear();
  channelCache.clear();
}

export async function isGuildApproved(guildId: string): Promise<boolean> {
  const hit = cached(guildCache, guildId);
  if (hit !== undefined) return hit;

  const row = unwrapMaybe<Pick<ApprovedGuildRow, 'guild_id'>>(
    await db().from(GUILDS).select('guild_id').eq('guild_id', guildId).eq('active', true).maybeSingle(),
    'approvedPlaces.isGuildApproved',
  );

  return remember(guildCache, guildId, row !== null);
}

export async function isChannelApproved(
  channelId: string,
  purpose: ChannelPurpose,
): Promise<boolean> {
  const key = `${channelId}:${purpose}`;
  const hit = cached(channelCache, key);
  if (hit !== undefined) return hit;

  const row = unwrapMaybe<Pick<ApprovedChannelRow, 'id'>>(
    await db()
      .from(CHANNELS)
      .select('id')
      .eq('channel_id', channelId)
      .eq('purpose', purpose)
      .eq('active', true)
      .maybeSingle(),
    'approvedPlaces.isChannelApproved',
  );

  return remember(channelCache, key, row !== null);
}

export async function listChannels(purpose: ChannelPurpose): Promise<ApprovedChannelRow[]> {
  return unwrap<ApprovedChannelRow[]>(
    await db().from(CHANNELS).select('*').eq('purpose', purpose).eq('active', true),
    'approvedPlaces.listChannels',
  );
}

export async function upsertGuild(input: {
  guildId: string;
  name?: string | null;
  createdBy?: string | null;
}): Promise<void> {
  unwrap<ApprovedGuildRow[]>(
    await db()
      .from(GUILDS)
      .upsert(
        { guild_id: input.guildId, name: input.name ?? null, active: true, created_by: input.createdBy ?? null },
        { onConflict: 'guild_id' },
      )
      .select('*'),
    'approvedPlaces.upsertGuild',
  );
  clearAllowListCache();
}

export async function upsertChannel(input: {
  guildId: string;
  channelId: string;
  purpose: ChannelPurpose;
  createdBy?: string | null;
}): Promise<void> {
  unwrap<ApprovedChannelRow[]>(
    await db()
      .from(CHANNELS)
      .upsert(
        {
          guild_id: input.guildId,
          channel_id: input.channelId,
          purpose: input.purpose,
          active: true,
          created_by: input.createdBy ?? null,
        },
        { onConflict: 'channel_id,purpose' },
      )
      .select('*'),
    'approvedPlaces.upsertChannel',
  );
  clearAllowListCache();
}
