import { DEPENDENCIES, dependencyConfiguration, DependencyName, isSetupMode } from '../config';
import { checkDiscord } from '../discord/client';
import { checkSupabase } from '../database';
import { checkBrowserbase } from '../readymode/session';
import { checkOpenAi } from '../openai';
import { isEncryptionConfigured } from '../security/encryption';
import { jobQueue } from '../queue';
import { getStore } from '../database';

/**
 * Health and readiness.
 *
 * /health answers 200 whenever the process is alive — Railway needs that even
 * during setup. /ready reports each dependency separately so an operator can
 * see exactly what is still missing.
 */

export interface DependencyStatus {
  name: DependencyName | 'queue';
  configured: boolean;
  ok: boolean;
  detail?: string;
  missing?: string[];
}

export interface ReadinessReport {
  ready: boolean;
  setupMode: boolean;
  uptimeSeconds: number;
  dependencies: DependencyStatus[];
  queue: ReturnType<typeof jobQueue.snapshot>;
}

export function liveness(): { status: 'ok'; uptimeSeconds: number; setupMode: boolean } {
  return {
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    setupMode: isSetupMode(),
  };
}

async function readymodeStatus(): Promise<{ ok: boolean; detail?: string }> {
  const store = getStore();
  if (store.kind === 'memory') {
    return { ok: false, detail: 'No database is connected, so no Readymode connection is stored.' };
  }
  return { ok: false, detail: 'Readymode connections are checked per organization.' };
}

/**
 * Probes every dependency. A failure here is reported, never thrown: the
 * endpoint has to answer even when everything downstream is unavailable.
 */
export async function readiness(): Promise<ReadinessReport> {
  const configuration = dependencyConfiguration();

  const probes: Record<DependencyName, () => Promise<{ ok: boolean; detail?: string }>> = {
    discord: checkDiscord,
    supabase: checkSupabase,
    browserbase: checkBrowserbase,
    readymode: readymodeStatus,
    openai: checkOpenAi,
    encryption: async () =>
      isEncryptionConfigured()
        ? { ok: true }
        : { ok: false, detail: 'ENCRYPTION_KEY is not set.' },
  };

  const dependencies: DependencyStatus[] = await Promise.all(
    DEPENDENCIES.map(async (name) => {
      const configured = configuration[name].configured;
      if (!configured) {
        return {
          name,
          configured,
          ok: false,
          detail: `Not configured: ${configuration[name].missing.join(', ')}`,
          missing: configuration[name].missing,
        };
      }
      try {
        const result = await withTimeout(probes[name](), 4000);
        return { name, configured, ok: result.ok, detail: result.detail };
      } catch (error) {
        return {
          name,
          configured,
          ok: false,
          detail: error instanceof Error ? error.message : 'Probe failed.',
        };
      }
    }),
  );

  const queue = jobQueue.snapshot();
  dependencies.push({
    name: 'queue',
    configured: true,
    ok: queue.paused.length === 0,
    detail:
      queue.paused.length > 0
        ? `Paused lanes: ${queue.paused.map((lane) => lane.key).join(', ')}`
        : `${queue.queued} queued, ${queue.running} running`,
  });

  // Readiness requires the dependencies the service cannot work without.
  const required: Array<DependencyName | 'queue'> = ['discord', 'supabase', 'encryption'];
  const ready = dependencies
    .filter((dependency) => required.includes(dependency.name))
    .every((dependency) => dependency.ok);

  return {
    ready,
    setupMode: isSetupMode(),
    uptimeSeconds: Math.round(process.uptime()),
    dependencies,
    queue,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Dependency check timed out.')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
