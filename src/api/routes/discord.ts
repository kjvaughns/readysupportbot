import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config';
import { requireAccess, requireRole } from '../../auth';
import { getClient, isDiscordConfigured } from '../../discord/client';
import { describeRegistrationError, registerCommands } from '../../discord/registerCommands';
import { COMMAND_NAMES } from '../../discord/commands';
import { getStore } from '../../database';
import { recordEvent } from '../../audit';
import { ACTION_TYPES, roleSchema } from '../../types';
import { getActionRoles, setActionRole } from '../../permissions/overrides';
import { DependencyNotConfiguredError, NotFoundError, ValidationError } from '../../security/errors';
import { sanitizePageValue } from '../../security/sanitize';
import { logger } from '../../security/logger';

/**
 * Discord installation and configuration, driven from the ReadySupport
 * frontend. Every endpoint verifies the Supabase token and the caller's role in
 * the organization being changed.
 */

const snowflake = z.string().regex(/^\d{5,25}$/, 'That is not a Discord id.');

export async function discordRoutes(app: FastifyInstance): Promise<void> {
  /** Install URL plus current installation state. */
  app.post('/discord/connect', async (request) => {
    const context = await requireRole(request, ['owner', 'administrator']);

    if (!isDiscordConfigured()) throw new DependencyNotConfiguredError('Discord');

    const permissions = '277025508352'; // View channels, send messages, read history, use commands.
    const installUrl = `https://discord.com/api/oauth2/authorize?client_id=${env.DISCORD_CLIENT_ID}&permissions=${permissions}&scope=bot%20applications.commands&state=${encodeURIComponent(context.organizationId)}`;

    const installation = await getStore().getInstallation(context.organizationId);

    return {
      installUrl,
      installed: Boolean(installation?.installed),
      guildId: installation?.guildId ?? null,
    };
  });

  /** Guilds the bot is in that this organization can claim. */
  app.get('/discord/guilds', async (request) => {
    const context = await requireAccess(request, 'manage_connections');
    const client = getClient();
    const installation = await getStore().getInstallation(context.organizationId);

    if (!client) {
      return { connected: false, guilds: [], installedGuildId: installation?.guildId ?? null };
    }

    const guilds = [...client.guilds.cache.values()].map((guild) => ({
      id: guild.id,
      name: sanitizePageValue(guild.name, 100),
      memberCount: guild.memberCount,
      claimed: guild.id === installation?.guildId,
    }));

    return { connected: true, guilds, installedGuildId: installation?.guildId ?? null };
  });

  /** Binds a guild to this organization. */
  app.post('/discord/install', async (request) => {
    const context = await requireRole(request, ['owner']);
    const body = z
      .object({
        guildId: snowflake,
        notificationChannelId: snowflake.optional(),
        requireMention: z.boolean().default(true),
      })
      .parse(request.body ?? {});

    const store = getStore();
    const existing = await store.getInstallationByGuild(body.guildId);
    if (existing && existing.organizationId !== context.organizationId) {
      throw new ValidationError('That Discord server is already connected to another organization.');
    }

    const installation = await store.upsertInstallation({
      organizationId: context.organizationId,
      guildId: body.guildId,
      installed: true,
      notificationChannelId: body.notificationChannelId ?? null,
      requireMention: body.requireMention,
    });

    await recordEvent({
      organizationId: context.organizationId,
      type: 'connection.updated',
      message: 'Discord installation was updated.',
      data: { guildId: body.guildId, requireMention: body.requireMention },
    });

    return { installation };
  });

  /**
   * Publishes the slash commands to Discord.
   *
   * This is the same work as `npm run register:commands`, exposed so it can be
   * done without shell access to the deployment. Registering is idempotent —
   * it replaces the published set with the current one — so re-running it after
   * every deploy is safe and is the simplest way to stay in step.
   *
   * A guildId registers to one server and appears immediately; without one the
   * commands register globally and can take up to an hour to propagate.
   */
  app.post('/discord/register-commands', async (request, reply) => {
    const context = await requireRole(request, ['owner', 'administrator']);
    const body = z.object({ guildId: snowflake.optional() }).parse(request.body ?? {});

    if (!isDiscordConfigured()) throw new DependencyNotConfiguredError('Discord');

    // Default to the installed guild, so commands show up straight away rather
    // than waiting on global propagation.
    const installation = await getStore().getInstallation(context.organizationId);
    const guildId = body.guildId ?? installation?.guildId;

    try {
      const count = await registerCommands(guildId);

      await recordEvent({
        organizationId: context.organizationId,
        type: 'connection.updated',
        message: `${count} slash command(s) registered${guildId ? ' for the connected server' : ' globally'}.`,
        data: { guildId: guildId ?? null, commands: COMMAND_NAMES },
      });

      return {
        ok: true,
        registered: count,
        scope: guildId ? 'guild' : 'global',
        guildId: guildId ?? null,
        commands: COMMAND_NAMES,
        message: guildId
          ? `${count} commands registered for the connected server. They are available immediately.`
          : `${count} commands registered globally. Discord can take up to an hour to show them everywhere.`,
      };
    } catch (error) {
      // Classified into a safe sentence plus structural diagnostics. The bot
      // token travels in a header Discord's error object never carries, and the
      // route is stripped of any query string before it is recorded.
      const failure = describeRegistrationError(error);

      logger.error(
        {
          requestId: request.id,
          organizationId: context.organizationId,
          discordCode: failure.code,
          httpStatus: failure.status,
          method: failure.method,
          route: failure.route,
          fields: failure.fields,
          reason: failure.reason,
        },
        'Slash command registration failed',
      );

      await recordEvent({
        organizationId: context.organizationId,
        type: 'connection.updated',
        message: `Slash command registration failed: ${failure.reason}`,
        data: { code: failure.code ?? null, status: failure.status ?? null, fields: failure.fields ?? [] },
      });

      return reply.status(502).send({
        ok: false,
        error: 'discord_registration_failed',
        reason: failure.reason,
        discordCode: failure.code ?? null,
        httpStatus: failure.status ?? null,
        route: failure.route ?? null,
        // Positions in the payload Discord objected to — structural, not user data.
        fields: failure.fields ?? [],
        requestId: request.id,
      });
    }
  });

  /** Channels ReadySupport is approved to work in. */
  app.get('/discord/channels', async (request) => {
    const context = await requireAccess(request, 'view_activity');
    const store = getStore();
    const approved = await store.listChannels(context.organizationId);
    const installation = await store.getInstallation(context.organizationId);

    const client = getClient();
    const available: Array<{ id: string; name: string }> = [];

    if (client && installation?.guildId) {
      const guild = client.guilds.cache.get(installation.guildId);
      if (guild) {
        for (const [id, channel] of guild.channels.cache) {
          if (channel.isTextBased()) {
            available.push({ id, name: sanitizePageValue(channel.name ?? id, 100) });
          }
        }
      }
    }

    return { approved, available };
  });

  /** Approves or removes a channel. */
  app.post('/discord/channels', async (request) => {
    const context = await requireRole(request, ['owner', 'administrator']);
    const body = z
      .object({
        channelId: snowflake,
        approved: z.boolean().default(true),
        autoSupport: z.boolean().default(false),
      })
      .parse(request.body ?? {});

    const store = getStore();
    const installation = await store.getInstallation(context.organizationId);
    if (!installation) throw new NotFoundError('Connect a Discord server first.');

    if (!body.approved) {
      await store.removeChannel(context.organizationId, body.channelId);
      return { removed: true };
    }

    const channel = await store.upsertChannel({
      organizationId: context.organizationId,
      guildId: installation.guildId,
      channelId: body.channelId,
      approved: true,
      autoSupport: body.autoSupport,
    });

    return { channel };
  });

  /** Discord roles, with the ReadySupport role each one maps to. */
  app.get('/discord/roles', async (request) => {
    const context = await requireAccess(request, 'view_activity');
    const store = getStore();
    const mappings = await store.listRoleMappings(context.organizationId);
    const installation = await store.getInstallation(context.organizationId);

    const client = getClient();
    const available: Array<{ id: string; name: string }> = [];

    if (client && installation?.guildId) {
      const guild = client.guilds.cache.get(installation.guildId);
      if (guild) {
        for (const [id, role] of guild.roles.cache) {
          available.push({ id, name: sanitizePageValue(role.name, 100) });
        }
      }
    }

    return { mappings, available };
  });

  /**
   * Which ReadySupport role each action needs.
   *
   * The role-to-permission table is the floor; this raises the bar for a
   * specific action without a deploy — for example requiring an Administrator
   * to create accounts, or to assign playlists.
   */
  app.get('/permissions/actions', async (request) => {
    const context = await requireAccess(request, 'view_activity');
    return { actionRoles: await getActionRoles(context.organizationId) };
  });

  app.post('/permissions/actions', async (request) => {
    const context = await requireRole(request, ['owner']);
    const body = z
      .object({
        action: z.enum(ACTION_TYPES),
        // null clears the override and falls back to the permission table.
        role: roleSchema.nullable(),
      })
      .parse(request.body ?? {});

    const actionRoles = await setActionRole(context.organizationId, body.action, body.role);

    await recordEvent({
      organizationId: context.organizationId,
      type: 'connection.updated',
      message: body.role
        ? `${body.action} now requires the ${body.role} role or above.`
        : `${body.action} reverted to the default role requirement.`,
      data: { action: body.action, role: body.role },
    });

    return { actionRoles };
  });

  /** Maps a Discord role, or a specific Discord user, to a ReadySupport role. */
  app.post('/permissions', async (request) => {
    const context = await requireRole(request, ['owner', 'administrator']);
    const body = z
      .object({
        discordRoleId: snowflake.optional(),
        discordUserId: snowflake.optional(),
        supabaseUserId: z.string().uuid().optional(),
        role: roleSchema,
      })
      .refine(
        (value) => value.discordRoleId || value.discordUserId || value.supabaseUserId,
        'Name a Discord role, a Discord user, or a Supabase user.',
      )
      .parse(request.body ?? {});

    // Only an Owner may grant Owner.
    if (body.role === 'owner' && context.role !== 'owner') {
      throw new ValidationError('Only an Owner can grant the Owner role.');
    }

    const store = getStore();
    const installation = await store.getInstallation(context.organizationId);

    if (body.discordRoleId) {
      if (!installation) throw new NotFoundError('Connect a Discord server first.');
      const mapping = await store.upsertRoleMapping({
        organizationId: context.organizationId,
        guildId: installation.guildId,
        discordRoleId: body.discordRoleId,
        role: body.role,
      });
      await recordEvent({
        organizationId: context.organizationId,
        type: 'connection.updated',
        message: `A Discord role was mapped to ${body.role}.`,
        data: { discordRoleId: body.discordRoleId },
      });
      return { mapping };
    }

    const member = await store.upsertMember({
      organizationId: context.organizationId,
      role: body.role,
      discordUserId: body.discordUserId ?? null,
      supabaseUserId: body.supabaseUserId ?? null,
      displayName: null,
    });

    await recordEvent({
      organizationId: context.organizationId,
      type: 'connection.updated',
      message: `A member was granted the ${body.role} role.`,
    });

    return { member };
  });
}
