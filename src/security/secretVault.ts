import { forgetSecret, registerSecret } from './redact.js';
import { minutes } from '../util/time.js';

/**
 * A short-lived, in-memory holding place for passwords.
 *
 * Two cases need one. An administrator may type a temporary password into a
 * Discord form, and it has to survive from that moment until the job runs —
 * but it must not be written to the database, so it cannot be carried on the
 * request row. And a generated password has to survive from the workflow
 * finishing until the ephemeral reply is delivered.
 *
 * Deliberate properties:
 *  - process memory only, never persisted, never logged
 *  - every value is registered with the redaction layer while it is held
 *  - entries expire, and are dropped the moment they are read
 *  - a restart loses everything here, which is the correct trade: the job
 *    falls back to generating a fresh password rather than reaching for a
 *    stored one
 */

interface VaultEntry {
  value: string;
  expiresAt: number;
}

const DEFAULT_TTL_MS = minutes(30);

const entries = new Map<string, VaultEntry>();

function prune(now = Date.now()): void {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) {
      forgetSecret(entry.value);
      entries.delete(key);
    }
  }
}

export function put(key: string, value: string, ttlMs = DEFAULT_TTL_MS): void {
  prune();
  registerSecret(value);
  entries.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Read without consuming. Used when a value is needed more than once. */
export function peek(key: string): string | undefined {
  prune();
  return entries.get(key)?.value;
}

/**
 * Read and remove. This is the normal way to get a value out: once a password
 * has been delivered to the requester there is no reason to keep holding it.
 */
export function take(key: string): string | undefined {
  prune();
  const entry = entries.get(key);
  if (!entry) return undefined;
  entries.delete(key);
  return entry.value;
}

/** Drop a value and stop tracking it for redaction. */
export function discard(key: string): void {
  const entry = entries.get(key);
  if (entry) {
    forgetSecret(entry.value);
    entries.delete(key);
  }
}

export function size(): number {
  prune();
  return entries.size;
}

export function clear(): void {
  for (const entry of entries.values()) forgetSecret(entry.value);
  entries.clear();
}

/** Key helpers, so callers do not invent their own conventions. */
export const keys = {
  /** A password an administrator supplied, waiting for the job to run. */
  providedPassword: (requestId: string) => `provided:${requestId}`,
  /** A password produced by a completed job, waiting to be delivered. */
  deliverablePassword: (requestId: string) => `deliver:${requestId}`,
};
