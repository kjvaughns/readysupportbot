import type { RepliableInteraction } from 'discord.js';
import { minutes } from '../util/time.js';

/**
 * Where to send a request's result.
 *
 * A job is queued and reported asynchronously, so by the time it finishes the
 * interaction that started it is elsewhere. This holds the handle needed to
 * finish that conversation.
 *
 * Discord interaction tokens are valid for fifteen minutes, and a restart
 * clears this map entirely, so the outcome sink always has a fallback: post
 * into the channel instead. Nothing here is required for correctness — the
 * result is recorded in the database either way — it only decides whether the
 * answer lands in the original reply or as a new message.
 */

const TTL_MS = minutes(14);

export interface PendingReply {
  interaction: RepliableInteraction;
  channelId: string;
  /** True when the answer must not be visible to the channel. */
  ephemeral: boolean;
  /** Who asked, so a fallback message can address them. */
  requesterDiscordId: string;
  expiresAt: number;
}

const pending = new Map<string, PendingReply>();

function prune(): void {
  const now = Date.now();
  for (const [key, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(key);
  }
}

export function remember(
  requestId: string,
  reply: Omit<PendingReply, 'expiresAt'>,
): void {
  prune();
  pending.set(requestId, { ...reply, expiresAt: Date.now() + TTL_MS });
}

export function take(requestId: string): PendingReply | undefined {
  prune();
  const entry = pending.get(requestId);
  if (entry) pending.delete(requestId);
  return entry;
}

export function peek(requestId: string): PendingReply | undefined {
  prune();
  return pending.get(requestId);
}

export function forget(requestId: string): void {
  pending.delete(requestId);
}

export function size(): number {
  prune();
  return pending.size;
}

export function clear(): void {
  pending.clear();
}
