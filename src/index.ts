import type { Server } from 'node:http';
import { loadEnv } from './config/env.js';
import { registerConfiguredSecrets } from './security/redact.js';
import { moduleLogger } from './util/logger.js';
import { createClient, login, registerHandlers } from './discord/client.js';
import { DiscordAlertSink } from './discord/alertSink.js';
import { DiscordOutcomeSink } from './discord/outcomeSink.js';
import { registerAlertSink } from './notify/notifier.js';
import { JobQueue, recoverAfterRestart } from './queue/queue.js';
import { createReadymodeService } from './readymode/service.js';
import { startHealthServer } from './health/server.js';
import * as browserSessions from './db/repositories/browserSessions.js';
import * as settings from './db/repositories/settings.js';
import * as runtime from './runtime.js';

/**
 * Boot.
 *
 * Order matters:
 *
 *  1. validate configuration, and register its secrets with the redaction
 *     layer before anything can log
 *  2. recover from however the last process ended
 *  3. connect to Discord, so alerts have somewhere to go
 *  4. start the queue, so work only begins once results can be reported
 */

const log = moduleLogger('boot');

async function main(): Promise<void> {
  const config = loadEnv();
  registerConfiguredSecrets();

  log.info(
    {
      nodeEnv: config.NODE_ENV,
      mode: config.READYSUPPORT_MODE,
      driver: config.READYMODE_DRIVER,
      guild: config.DISCORD_GUILD_ID,
    },
    'ReadySupport starting',
  );

  if (config.READYSUPPORT_MODE === 'dry_run') {
    log.warn(
      'Test mode is on: workflows will validate everything and stop before submitting. ' +
        'Set READYSUPPORT_MODE=live to make real changes.',
    );
  }

  // 2. Recovery. Anything interrupted mid-flight is failed for a human to
  //    check rather than retried, and browser sessions the old process left
  //    open are marked closed.
  const recovery = await recoverAfterRestart();
  await browserSessions.closeOrphaned();

  // 3. Discord.
  const client = createClient();
  registerHandlers(client);
  runtime.setClient(client);
  registerAlertSink(new DiscordAlertSink(client));

  await login(client);
  await waitUntilReady(client);

  // 4. Readymode driver and the queue.
  const service = createReadymodeService();
  runtime.setReadymodeService(service);

  const queue = new JobQueue({ service, sink: new DiscordOutcomeSink(client) });
  runtime.setQueue(queue);
  queue.start();

  const health = startHealthServer();

  if (recovery.paused) {
    log.warn('The queue is held. Run /reconnect_readymode once Readymode access is restored.');
  }

  installShutdownHandlers({ client, queue, health, service });

  log.info(
    { queued: recovery.queued, quarantined: recovery.quarantined },
    'ReadySupport is ready',
  );
}

function waitUntilReady(client: ReturnType<typeof createClient>): Promise<void> {
  if (client.isReady()) return Promise.resolve();
  return new Promise((resolve) => {
    client.once('clientReady', () => resolve());
  });
}

/**
 * Shut down without losing work.
 *
 * The queue is stopped first and allowed to finish the job in flight: a
 * workflow abandoned halfway is exactly how Readymode ends up in a state
 * nobody can account for. Pending and approved requests are all in the
 * database, so they are simply picked up by the next process.
 */
function installShutdownHandlers(parts: {
  client: ReturnType<typeof createClient>;
  queue: JobQueue;
  health: Server;
  service: ReturnType<typeof createReadymodeService>;
}): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    void (async () => {
      log.info({ signal }, 'Shutting down');

      try {
        await parts.queue.stop();
        await parts.service.shutdown();
        parts.health.close();
        await parts.client.destroy();
        log.info('Shutdown complete');
      } catch (cause) {
        log.error({ err: cause }, 'Shutdown did not finish cleanly');
      } finally {
        process.exit(0);
      }
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'Unhandled promise rejection');
  });

  process.on('uncaughtException', (error) => {
    log.fatal({ err: error }, 'Uncaught exception; shutting down');
    shutdown('uncaughtException');
  });
}

main().catch(async (cause) => {
  // Configuration problems happen before the logger has an environment to
  // read, so this deliberately writes to stderr directly.
  process.stderr.write(`ReadySupport failed to start: ${cause instanceof Error ? cause.message : String(cause)}\n`);

  try {
    await settings.set('queue_paused', {
      paused: true,
      reason: 'ReadySupport failed to start.',
      pausedBy: 'system',
      pausedAt: new Date().toISOString(),
    });
  } catch {
    // The database may be exactly what is unreachable. Nothing more to do.
  }

  process.exit(1);
});
