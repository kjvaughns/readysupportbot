/**
 * Secret redaction. Anything that leaves the process — logs, Discord replies,
 * API error bodies, audit records — passes through here first.
 */

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|api[_-]?key|authorization|auth|credential|cookie|session[_-]?id|service[_-]?role|encryption[_-]?key|private[_-]?key|bearer)/i;

export const REDACTED = '[redacted]';

/** Environment variables whose literal values must never appear in output. */
const SECRET_ENV_KEYS = [
  'ENCRYPTION_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  'SUPABASE_JWT_SECRET',
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_PUBLIC_KEY',
  'OPENAI_API_KEY',
  'BROWSERBASE_API_KEY',
  'READYMODE_PASSWORD',
];

function knownSecretValues(): string[] {
  const values: string[] = [];
  for (const key of SECRET_ENV_KEYS) {
    const value = process.env[key];
    // Very short values would cause runaway replacement in ordinary text.
    if (value && value.length >= 8) values.push(value);
  }
  return values;
}

/** Replaces known secret values and obvious credential patterns inside a string. */
export function redactString(input: string): string {
  let output = input;

  for (const secret of knownSecretValues()) {
    output = output.split(secret).join(REDACTED);
  }

  const patterns: RegExp[] = [
    // Discord bot tokens.
    /\b[A-Za-z0-9_-]{24,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g,
    // OpenAI style keys.
    /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    // Browserbase / generic bb keys.
    /\bbb_[A-Za-z0-9_-]{16,}\b/g,
    // JSON web tokens.
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    // Authorization headers written inline.
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    // key=value and "key": "value" pairs for sensitive names.
    /\b(password|passwd|secret|token|api[_-]?key|credential)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi,
  ];

  for (const pattern of patterns) {
    output = output.replace(pattern, (match) => {
      const keyed = match.match(
        /^\s*(password|passwd|secret|token|api[_-]?key|credential)\b\s*[:=]/i,
      );
      if (keyed) {
        const separator = match.includes(':') && !match.includes('=') ? ': ' : '=';
        return `${keyed[1]}${separator}${REDACTED}`;
      }
      return REDACTED;
    });
  }

  // Anything that looks like the encryption envelope should never be printed.
  output = output.replace(/\bv1:[A-Za-z0-9+/=]{10,}:[A-Za-z0-9+/=]{10,}:[A-Za-z0-9+/=]{10,}/g, REDACTED);

  return output;
}

/**
 * Deep-redacts a value: sensitive keys are replaced wholesale and every string
 * is scanned for secret material. Cycles are handled, depth is bounded.
 */
export function redact<T>(value: T, depth = 0, seen = new WeakSet<object>()): T {
  if (depth > 8) return REDACTED as unknown as T;
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (typeof value !== 'object') return value;

  if (seen.has(value as object)) return REDACTED as unknown as T;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen)) as unknown as T;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    } as unknown as T;
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = REDACTED;
      continue;
    }
    output[key] = redact(entry, depth + 1, seen);
  }
  return output as unknown as T;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}
