import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

/**
 * Every configuration value the process needs, validated once at boot.
 *
 * Anything missing or malformed aborts start-up with a readable report rather
 * than surfacing as a confusing runtime failure halfway through a job.
 */

const nonEmpty = (label: string) => z.string().trim().min(1, `${label} must not be empty`);

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  })
  .pipe(z.boolean());

const port = z.coerce.number().int().min(1).max(65_535);

const snowflake = z
  .string()
  .trim()
  .regex(/^\d{15,25}$/, 'must be a Discord snowflake (15-25 digits)');

export const READYSUPPORT_MODES = ['dry_run', 'live'] as const;
export type ReadysupportMode = (typeof READYSUPPORT_MODES)[number];

export const READYMODE_DRIVERS = ['live', 'mock'] as const;
export type ReadymodeDriver = (typeof READYMODE_DRIVERS)[number];

const envSchema = z.object({
  // Discord
  DISCORD_BOT_TOKEN: nonEmpty('DISCORD_BOT_TOKEN'),
  DISCORD_CLIENT_ID: snowflake,
  DISCORD_GUILD_ID: snowflake,
  DISCORD_NL_CHANNEL_ID: z.union([snowflake, z.literal('')]).optional().default(''),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: nonEmpty('SUPABASE_SERVICE_ROLE_KEY'),
  SUPABASE_EVIDENCE_BUCKET: z.string().trim().min(1).default('automation-evidence'),

  // OpenAI
  OPENAI_API_KEY: nonEmpty('OPENAI_API_KEY'),
  OPENAI_MODEL: z.string().trim().min(1).default('gpt-4o-mini'),

  // Browserbase
  BROWSERBASE_API_KEY: nonEmpty('BROWSERBASE_API_KEY'),
  BROWSERBASE_PROJECT_ID: nonEmpty('BROWSERBASE_PROJECT_ID'),
  BROWSERBASE_CONTEXT_ID: nonEmpty('BROWSERBASE_CONTEXT_ID'),

  // Readymode
  READYMODE_LOGIN_URL: z.string().url(),
  READYMODE_ADMIN_USERNAME: nonEmpty('READYMODE_ADMIN_USERNAME'),
  READYMODE_ADMIN_PASSWORD: nonEmpty('READYMODE_ADMIN_PASSWORD'),

  // Crypto
  ENCRYPTION_KEY: nonEmpty('ENCRYPTION_KEY'),

  // Behaviour
  READYSUPPORT_MODE: z.enum(READYSUPPORT_MODES).default('dry_run'),
  READYMODE_DRIVER: z.enum(READYMODE_DRIVERS).default('live'),
  ENABLE_CREATE_ACCOUNT: booleanish.default(false),
  ENABLE_CLEAR_LICENSE: booleanish.default(false),
  ENABLE_RESET_PASSWORD: booleanish.default(false),
  ENABLE_DEACTIVATE_ACCOUNT: booleanish.default(false),
  READYMODE_SELECTOR_OVERLAY: z.string().trim().default('config/readymode-selectors.json'),

  // Runtime
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: port.default(3000),
  APPROVAL_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  WORKFLOW_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(120_000),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Format a ZodError as a bullet list an operator can act on. */
function describe(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

/**
 * Parse and cache process environment. Throws with a full report of every
 * problem, not just the first one.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `ReadySupport cannot start: invalid environment configuration.\n${describe(parsed.error)}\n` +
        'See .env.example for the full list of required variables.',
    );
  }

  cached = parsed.data;
  return cached;
}

/** Test helper — drops the cached env so the next loadEnv re-parses. */
export function resetEnvCache(): void {
  cached = undefined;
}

/** The parsed environment. Call loadEnv() at boot before touching this. */
export function env(): Env {
  return loadEnv();
}
