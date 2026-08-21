import { announceBuild } from './buildInfo';
import { config, dependencyConfiguration, isSetupMode } from './config';
import { logger } from './security/logger';
import { startServer } from './api/server';
import { startDiscord, stopDiscord } from './discord';
import { jobQueue } from './queue';

/**
 * Entry point.
 *
 * The HTTP server starts first and unconditionally, so Railway's health check
 * passes even when Discord, Supabase, Browserbase, OpenAI or Readymode have not
 * been configured yet. Missing credentials put the service into setup mode; they
 * never stop the process.
 */
async function main(): Promise<void> {
  announceBuild();

  const app = await startServer();

  const configuration = dependencyConfiguration();
  const missing = Object.entries(configuration)
    .filter(([, value]) => !value.configured)
    .map(([name, value]) => `${name} (${value.missing.join(', ')})`);

  if (missing.length > 0) {
    logger.warn(
      { missing },
      'Setup mode: some dependencies are not configured. /health stays healthy and /ready lists what is missing.',
    );
  }

  if (config.dryRun) {
    logger.warn('DRY_RUN is on. Workflows will read and report, but will not save changes.');
  }

  // Discord failing to connect must not take the HTTP server down.
  startDiscord().catch((error) => {
    logger.error({ err: error }, 'Discord did not start; continuing in setup mode');
  });

  logger.info(
    { setupMode: isSetupMode(), nodeEnv: config.env.NODE_ENV },
    'ReadySupport backend started',
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    jobQueue.clear();
    await stopDiscord().catch(() => undefined);
    await app.close().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
  logger.error({ err: error }, 'Uncaught exception');
});

main().catch((error) => {
  logger.fatal({ err: error }, 'The service failed to start');
  process.exit(1);
});
