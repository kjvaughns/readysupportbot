import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAccess } from '../../auth';
import { getStore } from '../../database';
import { activityForRequest, recentActivity, recordEvent } from '../../audit';
import { dependencyConfiguration, isSetupMode, config } from '../../config';
import { discordStatus } from '../../discord/client';
import { isBrowserbaseConfigured } from '../../readymode/session';
import { credentialSummary } from '../../readymode/credentials';
import { isOpenAiConfigured } from '../../openai';
import { isEncryptionConfigured } from '../../security/encryption';
import { normalizeStateList, sortStates } from '../../readymode/states';
import { jobQueue, laneKey } from '../../queue';
import { NotFoundError, ValidationError } from '../../security/errors';

/**
 * Organization-level endpoints for the frontend: connection overview, state
 * configuration, activity feed, and request lookup.
 */
export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  /** Everything the dashboard needs to show setup progress. */
  app.get('/connections', async (request) => {
    const context = await requireAccess(request, 'view_activity');
    const store = getStore();

    const [installation, channels, roleMappings, connection, credentials] = await Promise.all([
      store.getInstallation(context.organizationId),
      store.listChannels(context.organizationId),
      store.listRoleMappings(context.organizationId),
      store.getConnection(context.organizationId),
      credentialSummary(context.organizationId),
    ]);

    const configuration = dependencyConfiguration();

    return {
      setupMode: isSetupMode(),
      dryRun: config.dryRun,
      discord: {
        ...discordStatus(),
        installation,
        channels,
        roleMappings,
      },
      readymode: {
        credentials,
        connection,
        queuePaused: jobQueue.isPaused(laneKey(context.organizationId)),
      },
      dependencies: {
        supabase: configuration.supabase,
        browserbase: { configured: isBrowserbaseConfigured() },
        openai: { configured: isOpenAiConfigured() },
        encryption: { configured: isEncryptionConfigured() },
      },
      role: context.role,
    };
  });

  /** Stored per-agent state assignments plus the organization default. */
  app.get('/state-configurations', async (request) => {
    const context = await requireAccess(request, 'check_agent_status');
    const store = getStore();

    const [configurations, defaults] = await Promise.all([
      store.listStateConfigurations(context.organizationId),
      store.getDefaultStates(context.organizationId),
    ]);

    return { configurations, defaultStates: defaults };
  });

  /**
   * Records a state configuration from the dashboard. Setting `default` writes
   * the baseline applied to newly created agents.
   */
  app.post('/state-configurations', async (request) => {
    const context = await requireAccess(request, 'configure_states');
    const body = z
      .object({
        readymodeUserId: z.string().min(1).max(64).optional(),
        username: z.string().min(1).max(128).optional(),
        states: z.array(z.string().min(1).max(64)).min(1).max(51),
        default: z.boolean().default(false),
      })
      .parse(request.body ?? {});

    const { states, invalid } = normalizeStateList(body.states);
    if (invalid.length > 0) {
      throw new ValidationError(`These are not recognized states: ${invalid.join(', ')}.`, {
        invalid,
      });
    }

    const store = getStore();

    if (body.default) {
      const previous = await store.getDefaultStates(context.organizationId);
      await store.setDefaultStates(context.organizationId, states, context.user.id);
      await recordEvent({
        organizationId: context.organizationId,
        type: 'states.defaults_changed',
        message: 'Default states for new agents were updated from the dashboard.',
        data: { previousStates: sortStates(previous), newStates: states },
      });
      return { defaultStates: states };
    }

    if (!body.readymodeUserId) {
      throw new ValidationError('A readymodeUserId is required unless default is true.');
    }

    const record = await store.upsertStateConfiguration({
      organizationId: context.organizationId,
      readymodeUserId: body.readymodeUserId,
      username: body.username ?? null,
      states,
      updatedBy: context.user.id,
    });

    await recordEvent({
      organizationId: context.organizationId,
      type: 'states.changed',
      message: `A state configuration was recorded for ${body.username ?? body.readymodeUserId}.`,
      data: { states },
    });

    return { configuration: record };
  });

  /**
   * Discord-to-Readymode links. These are what let "I" and "my" resolve to one
   * account; without a link the bot refuses to assume identity.
   */
  app.get('/linked-agents', async (request) => {
    const context = await requireAccess(request, 'view_activity');
    const query = z
      .object({ discordUserId: z.string().regex(/^\d{5,25}$/).optional() })
      .parse(request.query ?? {});

    if (!query.discordUserId) {
      // Membership is the only list the store exposes without a Readymode read.
      const members = await getStore().listMembers(context.organizationId);
      const links = await Promise.all(
        members
          .filter((member) => member.discordUserId)
          .map((member) =>
            getStore().listLinkedAgentsForDiscordUser(
              context.organizationId,
              member.discordUserId!,
            ),
          ),
      );
      return { linkedAgents: links.flat() };
    }

    return {
      linkedAgents: await getStore().listLinkedAgentsForDiscordUser(
        context.organizationId,
        query.discordUserId,
      ),
    };
  });

  app.post('/linked-agents', async (request) => {
    const context = await requireAccess(request, 'manage_members');
    const body = z
      .object({
        discordUserId: z.string().regex(/^\d{5,25}$/, 'That is not a Discord user id.'),
        readymodeUserId: z.string().min(1).max(64),
        username: z.string().min(1).max(128),
        fullName: z.string().max(128).optional(),
        email: z.string().email().max(254).optional(),
      })
      .parse(request.body ?? {});

    const linkedAgent = await getStore().upsertLinkedAgent({
      organizationId: context.organizationId,
      discordUserId: body.discordUserId,
      readymodeUserId: body.readymodeUserId,
      username: body.username,
      fullName: body.fullName ?? null,
      email: body.email ?? null,
    });

    await recordEvent({
      organizationId: context.organizationId,
      type: 'connection.updated',
      message: `A Discord account was linked to the Readymode account ${body.username}.`,
      data: { readymodeUserId: body.readymodeUserId },
    });

    return { linkedAgent };
  });

  /** Activity feed. */
  app.get('/activity', async (request) => {
    const context = await requireAccess(request, 'view_activity');
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(25) })
      .parse(request.query ?? {});

    const [events, requests] = await Promise.all([
      recentActivity(context.organizationId, query.limit),
      getStore().listRequests({ organizationId: context.organizationId, limit: query.limit }),
    ]);

    return { events, requests };
  });

  /** One request, with its approvals and audit trail. */
  app.get('/requests/:id', async (request) => {
    const context = await requireAccess(request, 'view_activity');
    const params = z.object({ id: z.string().min(1).max(64) }).parse(request.params ?? {});

    const store = getStore();
    let record = await store.getRequest(params.id);

    // The human-facing reference, for example "RS 1048", also resolves.
    if (!record) {
      record = await store.getRequestByReference(
        context.organizationId,
        params.id.replace(/^RS[-\s]?/i, 'RS '),
      );
    }

    // Organization isolation: a request from another organization reads as
    // missing rather than forbidden.
    if (!record || record.organizationId !== context.organizationId) {
      throw new NotFoundError('No such request.');
    }

    const [approvals, events] = await Promise.all([
      store.listApprovals(record.id),
      activityForRequest(record.id),
    ]);

    return { request: record, approvals, events };
  });
}
