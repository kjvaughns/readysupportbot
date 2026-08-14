import { ChannelType, TextChannel } from 'discord.js';
import { getClient } from '../discord/client';
import { getStore } from '../database';
import { logger } from '../security/logger';
import { escapeDiscord } from '../security/sanitize';

/**
 * Outbound notifications. Used when a request needs an Owner's attention —
 * a second approval, or Readymode asking for human verification.
 */

export async function notifyOrganization(
  organizationId: string,
  message: string,
): Promise<boolean> {
  const store = getStore();
  const installation = await store.getInstallation(organizationId);
  const channelId = installation?.notificationChannelId;
  const client = getClient();

  if (!channelId || !client) {
    logger.info({ organizationId }, `Notification not delivered: ${message}`);
    return false;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) return false;
    await (channel as TextChannel).send(escapeDiscord(message));
    return true;
  } catch (error) {
    logger.warn({ err: error, organizationId }, 'Failed to deliver notification');
    return false;
  }
}

export async function notifyAuthenticationRequired(
  organizationId: string,
  reference: string,
  reason: string,
): Promise<void> {
  await notifyOrganization(
    organizationId,
    [
      'ReadySupport needs a person to finish signing in to Readymode.',
      `Request: ${reference}`,
      `Reason: ${reason}`,
      'Queued work is paused. Reconnect from the ReadySupport dashboard to resume.',
    ].join('\n'),
  );
}

export async function notifySecondApprovalNeeded(
  organizationId: string,
  reference: string,
  summary: string,
): Promise<void> {
  await notifyOrganization(
    organizationId,
    [
      'A ReadySupport request needs a second Owner or Administrator.',
      `Request: ${reference}`,
      summary,
    ].join('\n'),
  );
}
