import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { allowedOrigins, config, env } from '../config';
import { logger } from '../security/logger';
import { newRequestId } from '../security/ids';
import { AppError, statusCodeFor, toSafeMessage } from '../security/errors';
import { healthRoutes } from './routes/health';
import { discordRoutes } from './routes/discord';
import { knowledgeRoutes } from './routes/knowledge';
import { readymodeRoutes } from './routes/readymode';
import { workspaceRoutes } from './routes/workspace';

/**
 * HTTP server.
 *
 * Built first and independently of every third-party dependency: it listens on
 * 0.0.0.0 and the Railway-provided PORT, and answers /health as soon as the
 * process is alive, whether or not Discord, Supabase or Readymode is set up.
 */
export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: env.MAX_REQUEST_BYTES,
    genReqId: () => newRequestId(),
  });

  const origins = allowedOrigins();
  if (config.isProduction && origins.length === 0) {
    // Never fall back to an open policy in production.
    logger.warn('FRONTEND_URL is not set. Browser requests from the frontend will be refused.');
  }

  await app.register(cors, {
    origin: (origin, callback) => {
      // Same-origin and server-to-server calls arrive without an Origin header.
      if (!origin) return callback(null, true);
      const normalized = origin.replace(/\/$/, '');
      callback(null, origins.includes(normalized));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Organization-Id'],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    // Rate limit per authenticated caller when possible, otherwise per address.
    keyGenerator: (request) => {
      const auth = request.headers.authorization;
      if (typeof auth === 'string' && auth.length > 16) return `token:${auth.slice(-16)}`;
      return request.ip;
    },
    allowList: (request) => request.url === '/health',
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
  });

  app.addHook('onResponse', async (request, reply) => {
    if (request.url === '/health') return;
    logger.info(
      {
        requestId: request.id,
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      },
      'request',
    );
  });

  app.setErrorHandler((error, request, reply) => {
    const status = statusCodeFor(error);

    if (status >= 500) {
      logger.error({ err: error, requestId: request.id }, 'Unhandled request error');
    } else {
      logger.warn(
        { requestId: request.id, code: error instanceof AppError ? error.code : 'error' },
        error instanceof Error ? error.message : 'Request failed',
      );
    }

    reply.status(status).send({
      error: error instanceof AppError ? error.code : 'internal_error',
      // Error text is always the safe form; internals never leave the process.
      message: toSafeMessage(error),
      requestId: request.id,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({ error: 'not_found', message: 'No such endpoint.', requestId: request.id });
  });

  await app.register(healthRoutes);
  await app.register(discordRoutes, { prefix: '/api' });
  await app.register(readymodeRoutes, { prefix: '/api' });
  await app.register(knowledgeRoutes, { prefix: '/api' });
  await app.register(workspaceRoutes, { prefix: '/api' });

  return app;
}

export async function startServer(): Promise<FastifyInstance> {
  const app = await buildServer();
  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info({ host: env.HOST, port: env.PORT }, 'HTTP server listening');
  return app;
}
