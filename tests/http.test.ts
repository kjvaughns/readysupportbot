import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server';
import { MemoryStore, setStore } from '../src/database';

/**
 * The HTTP surface has to come up with no third-party credentials configured:
 * /health stays 200 so Railway keeps the deployment, and /ready reports exactly
 * what is missing.
 */

let app: FastifyInstance;

beforeAll(async () => {
  setStore(new MemoryStore());
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('returns 200 while the process is alive, even in setup mode', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.setupMode).toBe(true);
    expect(typeof body.uptimeSeconds).toBe('number');
  });

  it('needs no authentication', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { authorization: '' },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('GET /ready', () => {
  it('reports 503 and names every unconfigured dependency', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);

    const body = response.json();
    expect(body.ready).toBe(false);
    expect(body.setupMode).toBe(true);

    const names = body.dependencies.map((dependency: any) => dependency.name);
    expect(names).toEqual(
      expect.arrayContaining(['discord', 'supabase', 'browserbase', 'readymode', 'openai', 'encryption', 'queue']),
    );

    const discord = body.dependencies.find((dependency: any) => dependency.name === 'discord');
    expect(discord.configured).toBe(false);
    expect(discord.detail).toMatch(/DISCORD_BOT_TOKEN/);

    // Encryption is configured in the test environment, so it passes.
    const encryption = body.dependencies.find((dependency: any) => dependency.name === 'encryption');
    expect(encryption.ok).toBe(true);
  });

  it('includes the job queue snapshot', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    const body = response.json();
    expect(body.queue).toHaveProperty('queued');
    expect(body.queue).toHaveProperty('paused');
  });
});

describe('API surface', () => {
  it('refuses an unauthenticated frontend request', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/connections?organizationId=org-a',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('unauthenticated');
  });

  it('never returns internal error detail', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/readymode/connect',
      payload: { organizationId: 'org-a', loginUrl: 'https://x.test', username: 'a', password: 'b' },
    });
    expect(response.statusCode).toBe(401);
    expect(JSON.stringify(response.json())).not.toContain('password');
  });

  it('answers 404 with a safe body for an unknown endpoint', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('not_found');
  });

  it('attaches a request id to every response', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('allows the configured frontend origin and refuses others', async () => {
    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/api/connections',
      headers: {
        origin: 'https://readysupport.test',
        'access-control-request-method': 'GET',
      },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://readysupport.test');

    const refused = await app.inject({
      method: 'OPTIONS',
      url: '/api/connections',
      headers: {
        origin: 'https://attacker.example',
        'access-control-request-method': 'GET',
      },
    });
    expect(refused.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('the honest status endpoint', () => {
  it('is gated like everything else', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/readymode/capabilities',
      headers: { 'x-organization-id': 'org-a' },
    });
    // 401 rather than 404 proves the route exists and requires a caller.
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('unauthenticated');
  });
});

describe('the knowledge endpoints', () => {
  it('gates the sync behind authentication', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/knowledge/sync',
      payload: { organizationId: 'org-a' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('exposes a sync endpoint, so a deployment needs no shell', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/knowledge/sync' });
    // 401 rather than 404 proves the route exists and is gated.
    expect(response.json().error).toBe('unauthenticated');
  });

  it('gates asking a question too', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/knowledge/ask',
      payload: { question: 'how do I configure a queue' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('slash command registration endpoint', () => {
  it('requires authentication', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/discord/register-commands',
      payload: { organizationId: 'org-a' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('is exposed so registration needs no shell access', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/discord/register-commands',
      payload: { organizationId: 'org-a' },
    });
    // 401 rather than 404 proves the route exists and is gated.
    expect(response.json().error).toBe('unauthenticated');
  });
});
