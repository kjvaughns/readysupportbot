import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';
import { errorFor } from '../domain/errors.js';

/**
 * The Supabase client.
 *
 * Uses the service role key, so it bypasses RLS. That is intentional — the bot
 * is the only client of this database and it enforces authorization itself in
 * src/auth. It also means this key must never leave the server process.
 */

let client: SupabaseClient | undefined;

export function db(): SupabaseClient {
  if (!client) {
    const config = env();
    client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'x-application-name': 'readysupport' } },
    });
  }
  return client;
}

/** Test helper — inject a stub or drop the cached client. */
export function setDbClient(replacement: SupabaseClient | undefined): void {
  client = replacement;
}

/**
 * Unwrap a PostgREST response.
 *
 * Database errors are turned into a ReadySupportError carrying an operator
 * message in `details` and a neutral sentence for the requester, so a
 * constraint name or a column list never reaches a Discord channel.
 */
export function unwrap<T>(
  result: { data: T | null; error: { message: string; code?: string; details?: string } | null },
  operation: string,
): T {
  if (result.error) {
    throw errorFor('UPSTREAM_UNAVAILABLE', {
      message: 'I could not reach the ReadySupport database, so I stopped without changing anything.',
      details: {
        operation,
        code: result.error.code,
        dbMessage: result.error.message,
        dbDetails: result.error.details,
      },
    });
  }
  if (result.data === null) {
    throw errorFor('UPSTREAM_UNAVAILABLE', {
      message: 'The ReadySupport database returned nothing for an operation that requires a result.',
      details: { operation },
    });
  }
  return result.data;
}

/** Same as unwrap, but a missing row is a legitimate answer. */
export function unwrapMaybe<T>(
  result: { data: T | null; error: { message: string; code?: string; details?: string } | null },
  operation: string,
): T | null {
  if (result.error) {
    // PGRST116 is "no rows returned" from .single(); treat it as absence.
    if (result.error.code === 'PGRST116') return null;
    throw errorFor('UPSTREAM_UNAVAILABLE', {
      message: 'I could not reach the ReadySupport database, so I stopped without changing anything.',
      details: {
        operation,
        code: result.error.code,
        dbMessage: result.error.message,
        dbDetails: result.error.details,
      },
    });
  }
  return result.data;
}

/** Cheap liveness probe used by the health check. */
export async function pingDatabase(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    const { error } = await db().from('system_settings').select('key').limit(1);
    if (error) {
      return { ok: false, latencyMs: Date.now() - started, error: error.message };
    }
    return { ok: true, latencyMs: Date.now() - started };
  } catch (cause) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
