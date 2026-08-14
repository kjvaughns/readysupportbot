import { FastifyInstance } from 'fastify';
import { liveness, readiness } from '../../health';

/**
 * Liveness and readiness.
 *
 * /health is unauthenticated and returns 200 whenever the process is alive, so
 * Railway keeps the deployment up while the operator finishes configuration.
 * /ready reports each dependency and returns 503 while anything required is
 * missing, without ever crashing the process.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    reply.status(200).send(liveness());
  });

  app.get('/ready', async (_request, reply) => {
    const report = await readiness();
    reply.status(report.ready ? 200 : 503).send(report);
  });
}
