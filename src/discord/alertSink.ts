import { EmbedBuilder, type Client } from 'discord.js';
import * as botUsers from '../db/repositories/botUsers.js';
import * as approvedPlaces from '../db/repositories/approvedPlaces.js';
import type { Alert, AlertSink } from '../notify/notifier.js';
import { COLORS } from './embeds.js';
import { formatReference } from '../util/ids.js';
import { escapeForDiscord, truncate } from '../util/text.js';
import { moduleLogger } from '../util/logger.js';

/**
 * Delivering owner alerts.
 *
 * An alert goes to every approved alerts channel and, for critical ones, as a
 * direct message to every OWNER as well. The redundancy is deliberate: the two
 * conditions that matter most — an expired session and a broken interface —
 * both mean the bot has stopped doing what someone is expecting it to do, and
 * a channel nobody is watching is not a notification.
 */

const log = moduleLogger('alert-sink');

const SEVERITY_COLOR = {
  info: COLORS.neutral,
  warning: COLORS.warning,
  critical: COLORS.failure,
} as const;

const SEVERITY_ICON = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🚨',
} as const;

export class DiscordAlertSink implements AlertSink {
  constructor(private readonly client: Client) {}

  async deliver(alert: Alert): Promise<void> {
    const embed = this.build(alert);

    const channels = await this.deliverToChannels(embed);
    const dms = alert.severity === 'critical' ? await this.deliverToOwners(embed) : 0;

    if (channels === 0 && dms === 0) {
      log.warn(
        { kind: alert.kind },
        'An alert had nowhere to go — no alerts channel is configured and no owner could be reached',
      );
    }
  }

  private build(alert: Alert): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setColor(SEVERITY_COLOR[alert.severity])
      .setTitle(`${SEVERITY_ICON[alert.severity]} ${truncate(alert.title, 240)}`)
      .setDescription(truncate(alert.message, 3000))
      .setTimestamp(new Date());

    if (alert.facts) {
      embed.addFields(
        Object.entries(alert.facts)
          .slice(0, 20)
          .map(([name, value]) => ({
            name: truncate(name, 256),
            // Facts can include text observed in Readymode, so they are
            // escaped like any other untrusted value.
            value: truncate(escapeForDiscord(value, 400), 1024),
            inline: false,
          })),
      );
    }

    if (alert.reference !== undefined) {
      embed.setFooter({ text: `Request ${formatReference(alert.reference)}` });
    }

    return embed;
  }

  private async deliverToChannels(embed: EmbedBuilder): Promise<number> {
    let delivered = 0;

    let targets;
    try {
      targets = await approvedPlaces.listChannels('ALERTS');
    } catch (cause) {
      log.error({ err: cause }, 'Could not look up the alerts channels');
      return 0;
    }

    for (const target of targets) {
      try {
        const channel = await this.client.channels.fetch(target.channel_id);
        if (channel?.isTextBased() && 'send' in channel) {
          await channel.send({ embeds: [embed] });
          delivered += 1;
        }
      } catch (cause) {
        log.warn({ err: cause, channelId: target.channel_id }, 'Could not post an alert to a channel');
      }
    }

    return delivered;
  }

  private async deliverToOwners(embed: EmbedBuilder): Promise<number> {
    let delivered = 0;

    let owners;
    try {
      owners = await botUsers.listOwners();
    } catch (cause) {
      log.error({ err: cause }, 'Could not look up owners');
      return 0;
    }

    for (const owner of owners) {
      try {
        const user = await this.client.users.fetch(owner.discord_user_id);
        await user.send({ embeds: [embed] });
        delivered += 1;
      } catch (cause) {
        // Owners commonly have direct messages closed. That is not an error
        // worth escalating as long as a channel got it.
        log.debug({ err: cause, ownerId: owner.discord_user_id }, 'Could not direct-message an owner');
      }
    }

    return delivered;
  }
}
