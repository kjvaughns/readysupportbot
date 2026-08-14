import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config';
import { logger } from '../security/logger';
import { DataStore } from './store';
import { MemoryStore } from './memoryStore';
import { SupabaseStore } from './supabaseStore';

export * from './store';
export { MemoryStore } from './memoryStore';

let serviceClient: SupabaseClient | null = null;
let store: DataStore | null = null;

export function isSupabaseConfigured(): boolean {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Service-role client. Backend only — this key is never sent to the frontend
 * and never appears in a response body.
 */
export function supabaseServiceClient(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
  if (!serviceClient) {
    serviceClient = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'x-application-name': 'readysupport-backend' } },
    });
  }
  return serviceClient;
}

/**
 * Client bound to a frontend user's access token, used to verify who they are.
 * Falls back to the service client only for token introspection.
 */
export function supabaseAuthClient(): SupabaseClient | null {
  if (!env.SUPABASE_URL) return null;
  const key = env.SUPABASE_ANON_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  return createClient(env.SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * The active store. Supabase when configured, otherwise an in-memory store so
 * the service still boots and reports setup mode instead of crashing.
 */
export function getStore(): DataStore {
  if (store) return store;
  const client = supabaseServiceClient();
  if (client) {
    store = new SupabaseStore(client);
  } else {
    logger.warn('Supabase is not configured. Using the in-memory store (setup mode).');
    store = new MemoryStore();
  }
  return store;
}

/** Test seam: replaces the active store. */
export function setStore(replacement: DataStore | null): void {
  store = replacement;
}

export async function checkSupabase(): Promise<{ ok: boolean; detail?: string }> {
  const client = supabaseServiceClient();
  if (!client) return { ok: false, detail: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.' };
  try {
    const { error } = await client.from('organizations').select('id').limit(1);
    if (error) return { ok: false, detail: `Query failed: ${error.code ?? 'unknown'}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'Unavailable.' };
  }
}
