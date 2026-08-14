import { createServer, type Server, type ServerResponse } from 'node:http';
import { env } from '../config/env.js';
import { moduleLogger } from '../util/logger.js';
import { runHealthChecks, runLivenessCheck } from './checks.js';

/**
 * A small HTTP surface for the hosting platform.
 *
 *   GET /health   full report, 200 unless something is outright failing
 *   GET /ready    cheap liveness probe for the platform's health check
 *
 * Deliberately unauthenticated but deliberately thin: it reports states and
 * counts, never account data, request contents, or anything that would be
 * useful to someone who found the URL.
 */

const log = moduleLogger('health-server');

export function startHealthServer(): Server {
  const server = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? '/';

      if (request.method !== 'GET') {
        respond(response, 405, { error: 'method not allowed' });
        return;
      }

      try {
        if (url.startsWith('/ready')) {
          const result = await runLivenessCheck();
          respond(response, result.ok ? 200 : 503, result);
          return;
        }

        if (url.startsWith('/health') || url === '/') {
          const report = await runHealthChecks();
          // A failing Readymode session is a real problem for the people using
          // the bot, but it is not a reason for the platform to recycle the
          // container — the process is healthy and holding work correctly.
          respond(response, report.state === 'failing' ? 503 : 200, report);
          return;
        }

        respond(response, 404, { error: 'not found' });
      } catch (cause) {
        log.error({ err: cause }, 'Health endpoint failed');
        respond(response, 500, { error: 'health check failed' });
      }
    })();
  });

  const port = env().PORT;
  server.listen(port, () => {
    log.info({ port }, 'Health endpoint listening');
  });

  server.on('error', (error) => {
    log.error({ err: error }, 'Health server error');
  });

  return server;
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}
