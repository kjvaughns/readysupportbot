import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAccess, requireRole } from '../../auth';
import { getStore } from '../../database';
import { recordEvent } from '../../audit';
import { jobQueue, laneKey } from '../../queue';
import {
  credentialInputSchema,
  credentialSummary,
  deleteCredentials,
  hasCredentials,
  storeCredentials,
} from '../../readymode/credentials';
import { openSession, ensureAuthenticated } from '../../readymode/session';
import { ALL_CONTROLS } from '../../readymode/selectors';
import { discoveryReport } from '../../readymode/selectors/discovery';
import { toSafeMessage } from '../../security/errors';
import { config } from '../../config';

/**
 * Readymode connection management.
 *
 * Credentials arrive here over HTTPS, are encrypted immediately, and only the
 * ciphertext is stored. No endpoint ever returns the password.
 */
export async function readymodeRoutes(app: FastifyInstance): Promise<void> {
  /** Stores or replaces the Readymode administrator credentials. */
  app.post('/readymode/connect', async (request) => {
    const context = await requireRole(request, ['owner', 'administrator']);
    const credentials = credentialInputSchema.parse(
      z.object({ organizationId: z.string().optional() }).passthrough().parse(request.body ?? {}),
    );

    const summary = await storeCredentials({
      organizationId: context.organizationId,
      credentials,
      actorId: context.user.id,
    });

    // The response deliberately carries metadata only.
    return { connection: summary, dryRun: config.dryRun };
  });

  /**
   * Re-establishes the session after Readymode asked for human verification.
   * New credentials may be supplied at the same time.
   */
  app.post('/readymode/reconnect', async (request) => {
    const context = await requireRole(request, ['owner', 'administrator']);
    const body = z
      .object({
        loginUrl: z.string().url().optional(),
        username: z.string().min(1).optional(),
        password: z.string().min(1).optional(),
      })
      .parse(request.body ?? {});

    if (body.loginUrl && body.username && body.password) {
      await storeCredentials({
        organizationId: context.organizationId,
        credentials: {
          loginUrl: body.loginUrl,
          username: body.username,
          password: body.password,
        },
        actorId: context.user.id,
      });
    } else if (!(await hasCredentials(context.organizationId))) {
      return {
        reconnected: false,
        message: 'No Readymode credentials are stored yet. Send the login URL, username and password.',
      };
    }

    const result = await attemptConnection(context.organizationId);

    if (result.ok) {
      jobQueue.resume(laneKey(context.organizationId));
      await recordEvent({
        organizationId: context.organizationId,
        type: 'connection.updated',
        message: 'Readymode was reconnected and queued work resumed.',
      });
    }

    return { reconnected: result.ok, message: result.message };
  });

  /** Current connection state. Never includes the password. */
  app.get('/readymode/status', async (request) => {
    const context = await requireAccess(request, 'view_activity');
    const store = getStore();
    const connection = await store.getConnection(context.organizationId);
    const credentials = await credentialSummary(context.organizationId);
    const lane = laneKey(context.organizationId);

    return {
      credentials,
      connection: connection
        ? {
            loginUrl: connection.loginUrl,
            username: connection.username,
            status: connection.status,
            lastVerifiedAt: connection.lastVerifiedAt,
            lastError: connection.lastError,
          }
        : null,
      queue: {
        paused: jobQueue.isPaused(lane),
        reason: jobQueue.pauseReason(lane) ?? null,
        depth: jobQueue.depth(lane),
      },
      dryRun: config.dryRun,
    };
  });

  /**
   * Signs in and reports which Readymode controls ReadySupport can identify.
   * Read-only: it never changes anything in Readymode.
   */
  app.post('/readymode/test', async (request) => {
    const context = await requireRole(request, ['owner', 'administrator']);

    const session = await openSession(context.organizationId).catch(() => null);
    if (!session) {
      return {
        ok: false,
        message: 'A browser session could not be started. Check the Browserbase configuration.',
      };
    }

    try {
      await ensureAuthenticated(session);
      const report = await discoveryReport(session.page, ALL_CONTROLS);

      await recordEvent({
        organizationId: context.organizationId,
        type: 'connection.tested',
        message: 'The Readymode connection was tested.',
        data: { resolved: report.resolved.length, unresolved: report.unresolved.length },
      });

      return {
        ok: report.unresolved.length === 0,
        signedIn: true,
        resolved: report.resolved,
        unresolved: report.unresolved,
        message:
          report.unresolved.length === 0
            ? 'Signed in and every required control was identified.'
            : `Signed in, but these controls need configuration: ${report.unresolved.join(', ')}.`,
      };
    } catch (error) {
      await recordEvent({
        organizationId: context.organizationId,
        type: 'connection.tested',
        message: 'The Readymode connection test did not succeed.',
        data: { error: toSafeMessage(error) },
      });
      return { ok: false, signedIn: false, message: toSafeMessage(error) };
    } finally {
      await session.close().catch(() => undefined);
    }
  });

  /** Only an Owner may delete stored credentials. */
  app.delete('/readymode/connect', async (request) => {
    const context = await requireRole(request, ['owner']);
    await deleteCredentials({
      organizationId: context.organizationId,
      actorId: context.user.id,
    });
    return { deleted: true };
  });
}

async function attemptConnection(
  organizationId: string,
): Promise<{ ok: boolean; message: string }> {
  const session = await openSession(organizationId).catch(() => null);
  if (!session) {
    return { ok: false, message: 'A browser session could not be started.' };
  }
  try {
    await ensureAuthenticated(session);
    return { ok: true, message: 'Readymode is connected.' };
  } catch (error) {
    return { ok: false, message: toSafeMessage(error) };
  } finally {
    await session.close().catch(() => undefined);
  }
}
