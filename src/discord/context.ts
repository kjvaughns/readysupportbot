import { getStore } from '../database';
import { highestRole, isRole } from '../permissions';
import { recordEvent } from '../audit';
import { Role } from '../types';

/**
 * Turns a Discord message or interaction into an authorized request context.
 *
 * A request is only accepted from a guild that has been installed and mapped to
 * an organization, in a channel that has been approved, by a user whose Discord
 * roles map to a ReadySupport role.
 */

export interface DiscordRequestInput {
  guildId?: string | null;
  channelId: string;
  userId: string;
  memberRoleIds: string[];
  /** True for slash commands, which are exempt from the mention requirement. */
  isCommand?: boolean;
}

export interface ResolvedDiscordContext {
  organizationId: string;
  role: Role;
  guildId: string;
  channelId: string;
  discordUserId: string;
  requireMention: boolean;
  autoSupportChannel: boolean;
  notificationChannelId?: string | null;
}

export type ContextResolution =
  | { status: 'ok'; context: ResolvedDiscordContext }
  | { status: 'rejected'; reason: string; quiet?: boolean };

export async function resolveDiscordContext(
  input: DiscordRequestInput,
): Promise<ContextResolution> {
  if (!input.guildId) {
    return {
      status: 'rejected',
      reason: 'ReadySupport only works inside a Discord server that an Owner has connected.',
    };
  }

  const store = getStore();
  const installation = await store.getInstallationByGuild(input.guildId);

  if (!installation || !installation.installed) {
    // Quiet: an unknown server should not get a running commentary.
    return {
      status: 'rejected',
      quiet: true,
      reason: 'This Discord server is not connected to a ReadySupport organization.',
    };
  }

  const organizationId = installation.organizationId;
  const channels = await store.listChannels(organizationId);
  const channel = channels.find((entry) => entry.channelId === input.channelId);

  if (!channel || !channel.approved) {
    await recordEvent({
      organizationId,
      type: 'channel.rejected',
      message: 'A request arrived from a channel that has not been approved.',
      data: { channelId: input.channelId },
    });
    return {
      status: 'rejected',
      reason:
        channels.length === 0
          ? 'No channels have been approved for ReadySupport yet. An Owner can approve one in the dashboard.'
          : 'ReadySupport is not approved to work in this channel.',
    };
  }

  const role = await resolveRole(organizationId, input.userId, input.memberRoleIds);
  if (!role) {
    await recordEvent({
      organizationId,
      type: 'permission.denied',
      message: 'A Discord user with no mapped ReadySupport role made a request.',
      data: { discordUserId: input.userId },
    });
    return {
      status: 'rejected',
      reason: 'Your Discord account is not mapped to a ReadySupport role. Ask an Owner to add you.',
    };
  }

  return {
    status: 'ok',
    context: {
      organizationId,
      role,
      guildId: input.guildId,
      channelId: input.channelId,
      discordUserId: input.userId,
      requireMention: installation.requireMention,
      autoSupportChannel: channel.autoSupport,
      notificationChannelId: installation.notificationChannelId ?? null,
    },
  };
}

/**
 * A direct membership record wins over role mappings; otherwise the most
 * capable mapped role applies.
 */
export async function resolveRole(
  organizationId: string,
  discordUserId: string,
  memberRoleIds: string[],
): Promise<Role | null> {
  const store = getStore();

  const member = await store.getMemberByDiscordUser(organizationId, discordUserId);
  if (member && isRole(member.role)) return member.role;

  const mappings = await store.listRoleMappings(organizationId);
  const matched = mappings
    .filter((mapping) => memberRoleIds.includes(mapping.discordRoleId))
    .map((mapping) => mapping.role)
    .filter(isRole);

  return highestRole(matched);
}
