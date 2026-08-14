import { env } from '../config/env.js';

export const REDACTED = '[redacted]';

/**
 * Secret hygiene.
 *
 * Two independent layers, because either one alone leaks eventually:
 *
 *  1. Key-based redaction — any field whose *name* looks like a secret is
 *     replaced, however deeply nested.
 *  2. Value-based scrubbing — every secret this process knows about (config
 *     credentials, and any temporary password generated for a request) is
 *     registered here, and every log line and audit payload has those exact
 *     strings stripped out. This catches a password that ends up somewhere
 *     nobody anticipated, such as inside a Readymode error banner echoed back
 *     to us.
 */

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|api[-_]?key|authorization|auth[-_]?header|cookie|session[-_]?id|credential|private[-_]?key|encryption[-_]?key|service[-_]?role)/i;

/**
 * Field names that read as sensitive but are safe and useful in an audit.
 *
 * The Browserbase session id belongs here: it identifies a session, it is not
 * a credential, it is already a column in browser_sessions, and redacting it
 * would make the browser history unreadable for no gain.
 */
const ALLOWED_KEYS = new Set([
  'passwordDelivered',
  'password_delivered',
  'passwordDeliveredAt',
  'password_delivered_at',
  'passwordSource',
  'password_source',
  'tokenCount',
  'token_count',
  'browserSessionId',
  'browserbase_session_id',
  'browserbaseSessionId',
]);

export function isSensitiveKey(key: string): boolean {
  if (ALLOWED_KEYS.has(key)) return false;
  return SENSITIVE_KEY_PATTERN.test(key);
}

// ---------------------------------------------------------------------------
// Value registry
// ---------------------------------------------------------------------------

/**
 * Registered secret values. Anything shorter than this is not registered —
 * scrubbing a 4-character string out of every log line would mangle unrelated
 * text far more often than it would protect anything.
 */
const MIN_SECRET_LENGTH = 8;

const secretValues = new Set<string>();

/** Track a secret for the rest of its life in this process. */
export function registerSecret(value: string | undefined | null): void {
  if (!value) return;
  if (value.length < MIN_SECRET_LENGTH) return;
  secretValues.add(value);
}

/**
 * Stop tracking a secret. Called once a temporary password has been delivered
 * to the requester and dropped, so the set does not grow without bound.
 */
export function forgetSecret(value: string | undefined | null): void {
  if (!value) return;
  secretValues.delete(value);
}

/** Test helper. */
export function clearSecretRegistry(): void {
  secretValues.clear();
}

let configSecretsLoaded = false;

/**
 * Register the credentials held in configuration. Called once at boot, after
 * the environment has been validated.
 */
export function registerConfiguredSecrets(): void {
  if (configSecretsLoaded) return;
  const config = env();
  for (const value of [
    config.DISCORD_BOT_TOKEN,
    config.SUPABASE_SERVICE_ROLE_KEY,
    config.OPENAI_API_KEY,
    config.BROWSERBASE_API_KEY,
    config.READYMODE_ADMIN_PASSWORD,
    config.ENCRYPTION_KEY,
  ]) {
    registerSecret(value);
  }
  configSecretsLoaded = true;
}

/** Replace every registered secret value found anywhere in the text. */
export function scrubSecretValues(text: string): string {
  let out = text;
  for (const secret of secretValues) {
    if (out.includes(secret)) {
      out = out.split(secret).join(REDACTED);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Structure-aware redaction
// ---------------------------------------------------------------------------

const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 2_000;

/**
 * Deep-copy a value with secrets removed. Safe to hand straight to the audit
 * log or the structured logger.
 *
 * - Sensitive keys are replaced with the marker regardless of their value.
 * - Every surviving string has registered secret values scrubbed out.
 * - Cycles, oversized arrays and oversized strings are truncated rather than
 *   throwing, so logging can never take down a job.
 */
export function sanitize<T>(value: T): unknown {
  return sanitizeInner(value, 0, new WeakSet());
}

function sanitizeInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    const scrubbed = scrubSecretValues(value);
    return scrubbed.length > MAX_STRING_LENGTH
      ? `${scrubbed.slice(0, MAX_STRING_LENGTH)}...[truncated]`
      : scrubbed;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (value instanceof Date) return value.toISOString();

  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubSecretValues(value.message),
      ...(typeof (value as { category?: unknown }).category === 'string'
        ? { category: (value as { category?: string }).category }
        : {}),
    };
  }

  if (depth >= MAX_DEPTH) return '[depth limit]';

  if (typeof value === 'object') {
    if (seen.has(value as object)) return '[circular]';
    seen.add(value as object);

    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeInner(item, depth + 1, seen));
      if (value.length > MAX_ARRAY_ITEMS) {
        items.push(`[${value.length - MAX_ARRAY_ITEMS} more items omitted]`);
      }
      return items;
    }

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        out[key] = item === undefined || item === null ? item : REDACTED;
        continue;
      }
      const sanitized = sanitizeInner(item, depth + 1, seen);
      if (sanitized !== undefined) out[key] = sanitized;
    }
    return out;
  }

  return String(value);
}

/**
 * Sanitize a payload for storage in automation_requests / automation_events.
 * Always returns a plain JSON object so it can go straight into a jsonb column.
 */
export function sanitizeForAudit(value: unknown): Record<string, unknown> {
  const sanitized = sanitize(value);
  if (sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)) {
    return sanitized as Record<string, unknown>;
  }
  return { value: sanitized };
}
