import 'dotenv/config';
import { z } from 'zod';

/**
 * Configuration is intentionally forgiving. The HTTP health server has to come
 * up on Railway even when Discord, Supabase, Browserbase, OpenAI or Readymode
 * have not been configured yet, so every third-party value is optional and the
 * gaps are reported through /ready instead of crashing the process.
 */

const optionalString = z
  .string()
  .trim()
  .min(1)
  .optional()
  .catch(undefined);

const booleanish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return fallback;
      return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    });

const intWithDefault = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return fallback;
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(max, Math.max(min, parsed));
    });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).catch('development'),
  PORT: intWithDefault(8080, 1, 65535),
  HOST: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : '0.0.0.0')),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .catch('info'),
  PUBLIC_BASE_URL: optionalString,
  FRONTEND_URL: optionalString,
  DRY_RUN: booleanish(true),

  ENCRYPTION_KEY: optionalString,

  SUPABASE_URL: optionalString,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,
  SUPABASE_ANON_KEY: optionalString,
  SUPABASE_JWT_SECRET: optionalString,

  DISCORD_BOT_TOKEN: optionalString,
  DISCORD_CLIENT_ID: optionalString,
  DISCORD_CLIENT_SECRET: optionalString,
  DISCORD_PUBLIC_KEY: optionalString,

  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : 'gpt-4o-mini')),

  BROWSERBASE_API_KEY: optionalString,
  BROWSERBASE_PROJECT_ID: optionalString,
  BROWSERBASE_CONTEXT_ID: optionalString,

  READYMODE_BASE_URL: optionalString,
  READYMODE_USERNAME: optionalString,
  READYMODE_PASSWORD: optionalString,

  APPROVAL_TTL_SECONDS: intWithDefault(600, 60, 3600),
  MAX_REQUEST_BYTES: intWithDefault(131072, 1024, 5_242_880),
  RATE_LIMIT_MAX: intWithDefault(120, 1, 100000),
  RATE_LIMIT_WINDOW_MS: intWithDefault(60_000, 1000, 3_600_000),
  MAX_BULK_ACCOUNTS: intWithDefault(25, 1, 200),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (parsed.success) return parsed.data;

  // Should be unreachable — every field either has a default or is optional.
  // Falling back keeps the health server alive rather than failing to boot.
  console.error('Configuration fell back to defaults:', parsed.error.flatten().fieldErrors);
  return envSchema.parse({});
}

export const env: Env = loadEnv();

export const config = {
  env,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  dryRun: env.DRY_RUN,
  approvalTtlMs: env.APPROVAL_TTL_SECONDS * 1000,
  maxBulkAccounts: env.MAX_BULK_ACCOUNTS,
};

/** Names of the dependencies reported through /ready. */
export const DEPENDENCIES = [
  'discord',
  'supabase',
  'browserbase',
  'readymode',
  'openai',
  'encryption',
] as const;

export type DependencyName = (typeof DEPENDENCIES)[number];

export interface DependencyConfiguration {
  configured: boolean;
  missing: string[];
}

/**
 * Reports which dependencies have credentials present. This is a static check
 * of configuration only — live connectivity is probed by the health module.
 */
export function dependencyConfiguration(): Record<DependencyName, DependencyConfiguration> {
  const check = (entries: Array<[string, string | undefined]>): DependencyConfiguration => {
    const missing = entries.filter(([, value]) => !value).map(([name]) => name);
    return { configured: missing.length === 0, missing };
  };

  return {
    discord: check([
      ['DISCORD_BOT_TOKEN', env.DISCORD_BOT_TOKEN],
      ['DISCORD_CLIENT_ID', env.DISCORD_CLIENT_ID],
    ]),
    supabase: check([
      ['SUPABASE_URL', env.SUPABASE_URL],
      ['SUPABASE_SERVICE_ROLE_KEY', env.SUPABASE_SERVICE_ROLE_KEY],
    ]),
    browserbase: check([
      ['BROWSERBASE_API_KEY', env.BROWSERBASE_API_KEY],
      ['BROWSERBASE_PROJECT_ID', env.BROWSERBASE_PROJECT_ID],
    ]),
    // Readymode credentials normally arrive per organization through the
    // frontend, so configuration here is satisfied by either source.
    readymode: check([['READYMODE_BASE_URL or a stored connection', env.READYMODE_BASE_URL]]),
    openai: check([['OPENAI_API_KEY', env.OPENAI_API_KEY]]),
    encryption: check([['ENCRYPTION_KEY', env.ENCRYPTION_KEY]]),
  };
}

/** True when at least one required dependency is unconfigured. */
export function isSetupMode(): boolean {
  const configuration = dependencyConfiguration();
  return (['discord', 'supabase', 'encryption'] as const).some(
    (name) => !configuration[name].configured,
  );
}

/** Origins permitted by CORS. Production never falls back to a wildcard. */
export function allowedOrigins(): string[] {
  const raw = env.FRONTEND_URL ?? '';
  const parsed = raw
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (parsed.length > 0) return parsed;
  if (config.isProduction) return [];
  return ['http://localhost:3000', 'http://localhost:5173'];
}
